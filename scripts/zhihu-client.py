"""Narrow, JSON-only adapter for pyzhihu-cli; never persist or print cookies."""

import hashlib
import json
import logging
import re
import sys
import time
from contextlib import ExitStack
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, urlparse

from requests.cookies import create_cookie
from PIL import Image
from zhihu_cli.client import ZHIHU_IMAGE_API, ZhihuClient
from zhihu_article_diagrams import diagram_images
from zhihu_article_format import (
    ArticleLayout,
    VisibleText,
    format_structure,
    mention_names,
    apply_mentions,
    canonical_cards,
    normalize,
    prepare as prepare_layout,
)

logging.disable(logging.CRITICAL)


def has_catalog_headings(html):
    """Use only nonempty native chapter headings; never invent headings from prose."""
    starts = {"h2": [], "h3": []}
    for style in json.loads(format_structure(html))["styles"]:
        if style[0] in ("+h2", "+h3"):
            starts[style[0][1:]].append(style[1])
        elif style[0] in ("-h2", "-h3"):
            heading = starts[style[0][1:]]
            if heading and style[1] > heading.pop():
                return True
    return False


def catalog_setting(article):
    return article.get("settings", {}).get("table_of_contents", {}).get("enabled") is True


def validate_links(html):
    parser = ArticleLayout()
    parser.feed(canonical_cards(html))
    for href in parser.links:
        parsed = urlparse(href)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError("article_link_unsupported")


def prepare(nodes, first_published_at=None, ai_generated_tag_rem_id=None, mention_bindings=None, series_label=None, diagrams=None):
    result = prepare_layout(nodes, first_published_at, ai_generated_tag_rem_id, diagrams)
    if series_label is not None:
        if not isinstance(series_label, str) or not re.fullmatch(r"第[1-9]\d* 篇 \| day [1-9]\d*", series_label) or first_published_at is None:
            raise ValueError("article_series_footer_invalid")
        tail = "<p>首次发布时间：" + first_published_at + "</p>"
        if not result["html"].endswith(tail):
            raise ValueError("article_series_footer_position_invalid")
        result["html"] = result["html"][:-len(tail)] + "<p>" + series_label + "</p>" + tail
        result["seriesLabel"] = series_label
    bindings = mention_bindings or []
    result["html"] = apply_mentions(result["html"], bindings)
    result["text"] = normalize(result["html"])
    result["format"] = format_structure(result["html"])
    result["mentionBindings"] = sorted(bindings, key=lambda item: item["name"])
    result["tableOfContents"] = has_catalog_headings(result["html"])
    validate_links(result["html"])
    return result


def resolve_mentions(client, names, configured):
    bindings = {}
    for item in configured:
        if item["name"] in bindings or not re.fullmatch(r"[a-f0-9]{32}", item["id"]):
            raise ValueError("mention_binding_invalid")
        bindings[item["name"]] = item["id"]
    if len(names) > 8:
        raise ValueError("mention_batch_too_large")
    result = []
    for name in names:
        member_id = bindings.get(name)
        if not member_id:
            candidates = set()
            offset = 0
            for page_index in range(3):
                page = client.search(name, search_type="people", offset=offset, limit=20)
                items = page.get("data", [])
                for item in items:
                    person = item.get("object", item)
                    parsed = VisibleText()
                    parsed.feed(person.get("name", ""))
                    if person.get("type") == "people" and "".join(parsed.parts) == name:
                        candidates.add(person.get("id", ""))
                if not items or page.get("paging", {}).get("is_end") is True:
                    break
                offset += len(items)
            else:
                raise ValueError("mention_search_incomplete")
            if len(candidates) != 1:
                raise ValueError("mention_ambiguous_or_missing")
            member_id = next(iter(candidates))
        if not re.fullmatch(r"[a-f0-9]{32}", member_id):
            raise ValueError("mention_identity_invalid")
        profile = client._get(f"https://www.zhihu.com/api/v4/members/{member_id}", {"include": "id,name,url_token"})
        if profile.get("id") != member_id or profile.get("name") != name:
            raise ValueError("mention_profile_changed")
        result.append({"name": name, "id": member_id})
    return result


def load_client(snapshot_path, article_images=False):
    snapshot = json.loads(Path(snapshot_path).read_text(encoding="utf-8-sig"))
    if snapshot.get("schema") != "local.chrome-cookie-snapshot" or snapshot.get("schemaVersion") != 1:
        raise ValueError("cookie_snapshot_schema_mismatch")
    generated = datetime.fromisoformat(snapshot["generatedAt"].replace("Z", "+00:00")).timestamp()
    if not -30 <= time.time() - generated <= 900:
        raise ValueError("cookie_snapshot_stale")
    cookies = []
    for cookie in snapshot["cookies"]:
        domain = cookie.get("domain", "").lstrip(".").lower()
        if domain not in ("zhihu.com", "www.zhihu.com") or cookie.get("partitionKey"):
            continue
        if cookie.get("expirationDate") and cookie["expirationDate"] <= time.time():
            continue
        if cookie.get("path", "/") != "/":
            continue
        cookies.append(cookie)
    required = {"z_c0", "_xsrf", "d_c0"}
    if not required.issubset({cookie["name"] for cookie in cookies}):
        raise ValueError("zhihu_login_cookies_missing")
    # Preserve host-only/domain and path scope, unlike the CLI's convenience constructor.
    client = ZhihuClient({})
    for cookie in cookies:
        item = create_cookie(
            name=cookie["name"], value=cookie["value"], domain=cookie["domain"],
            path=cookie.get("path", "/"), secure=cookie.get("secure", False),
        )
        item.domain_specified = not cookie.get("hostOnly", False)
        client._session.cookies.set_cookie(item)
    xsrf = next(cookie["value"] for cookie in cookies if cookie["name"] == "_xsrf")
    client._session.headers["x-xsrftoken"] = xsrf
    original_request = client._session.request

    def scoped_request(method, url, **kwargs):
        parsed = urlparse(url)
        media = article_images and parsed.netloc == "api.zhihu.com" and not (parsed.query or parsed.fragment) and (
            (method.upper() == "POST" and parsed.path == "/images") or
            (method.upper() == "GET" and re.fullmatch(r"/images/[A-Za-z0-9_-]+", parsed.path)) or
            (method.upper() == "PUT" and re.fullmatch(r"/images/[A-Za-z0-9_-]+/uploading_status", parsed.path))
        )
        if parsed.scheme != "https" or (parsed.hostname not in ("www.zhihu.com", "zhuanlan.zhihu.com") and not media):
            raise ValueError("zhihu_request_host_blocked")
        kwargs["allow_redirects"] = False
        return original_request(method, url, **kwargs)

    client._session.request = scoped_request
    return client


def upload_article_image(client, filename):
    """Complete the current Zhihu editor protocol before invoking the SDK poller."""
    file = Path(filename)
    data = file.read_bytes()
    with Image.open(file) as image:
        width, height = image.size
        if image.format != "PNG" or width < 1 or height < 1:
            raise ValueError("article_image_invalid_png")
    registered = client._session.post(ZHIHU_IMAGE_API, json={
        "image_hash": hashlib.md5(data, usedforsecurity=False).hexdigest(), "source": "article",
    }, timeout=15)
    if registered.status_code != 200:
        raise ValueError("article_image_registration_failed")
    result = registered.json()
    upload = result["upload_file"]
    image_id = str(upload["image_id"])
    if not re.fullmatch(r"[A-Za-z0-9_-]+", image_id):
        raise ValueError("article_image_id_invalid")
    if upload["state"] == 2:
        client._upload_to_oss(upload["object_key"], data, result["upload_token"])
        acknowledged = client._session.put(f"{ZHIHU_IMAGE_API}/{image_id}/uploading_status",
                                            json={"upload_result": "success"}, timeout=15)
        if acknowledged.status_code not in (200, 204):
            raise ValueError("article_image_confirmation_failed")
    elif upload["state"] != 1:
        raise ValueError("article_image_registration_unknown")
    return {**read_article_image(client, image_id), "imageId": image_id, "width": width, "height": height}


def read_article_image(client, image_id):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", image_id):
        raise ValueError("article_image_id_invalid")
    info = client._poll_image(image_id)
    for name in ("src", "original_src", "watermark_src"):
        address = info.get(name)
        if address:
            parsed = urlparse(address)
            if not Path(parsed.path).suffix:
                address = parsed._replace(path=parsed.path + ".png").geturl()
        if address and address.startswith("//"):
            address = "https:" + address
        if address:
            info[name] = address
    info["src"] = info.get("original_src") or info["src"]
    return info


def article_id_from_result(result):
    for key in ("id", "article_id"):
        value = str(result.get(key, ""))
        if re.fullmatch(r"\d+", value):
            return value
    for key in ("url", "redirect_url"):
        match = re.fullmatch(r"https://zhuanlan\.zhihu\.com/p/(\d+)/?", result.get(key, ""))
        if match:
            return match[1]
    raise ValueError("publish_result_id_missing")


def accepted_column_ids(article):
    return sorted({str(column.get('url_token') or column['id'])
        for item in article.get('contributions', []) if item.get('state') == 'accepted'
        and (column := item.get('column', {})) and (column.get('url_token') or column.get('id'))})


def read_article(client, article_id):
    if not re.fullmatch(r"\d+", article_id):
        raise ValueError("invalid_article_id")
    for attempt in range(4):
        article = client._get(f"https://zhuanlan.zhihu.com/api/articles/{article_id}")
        if article.get("state") == "published" and article.get("is_visible") is not False and not article.get("content_need_truncated"):
            break
        if attempt < 3:
            time.sleep(2)
    if article.get("state") != "published" or article.get("is_visible") is False or article.get("content_need_truncated"):
        raise ValueError("article_not_published")
    html = article.get("content", "")
    if not isinstance(html, str) or not html:
        raise ValueError("article_content_missing")
    return {"id": str(article.get("id", "")), "authorId": article.get("author", {}).get("id", ""),
            "title": article.get("title", "") or "", "text": normalize(html), "format": format_structure(html),
            "columnIds": accepted_column_ids(article), "tableOfContents": catalog_setting(article),
            "url": f"https://zhuanlan.zhihu.com/p/{article_id}"}


def check_column(client, column_id):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", column_id):
        raise ValueError("invalid_column_id")
    column = client._get(f"https://zhuanlan.zhihu.com/api/columns/{column_id}")
    if (column.get("url_token") or column.get("id")) != column_id or column.get("can_manage") is not True:
        raise ValueError("column_not_manageable")
    return {"columnId": column_id, "columnTitle": column.get("title", "")}


def columns_for_tags(client, url_token, tags):
    names = set(tags)
    if not names:
        return []
    url = f"https://www.zhihu.com/api/v4/members/{quote(url_token, safe='')}/column-contributions"
    offset, seen, matched = 0, set(), {}
    for _ in range(50):
        page = client._get(url, {"limit": 20, "offset": offset})
        items = page["data"]
        for item in items:
            column = item["column"]
            token = str(column.get("url_token") or column["id"])
            if token in seen:
                raise ValueError("column_listing_duplicate")
            seen.add(token)
            title = column["title"]
            if title in names:
                verified = check_column(client, token)
                if verified["columnTitle"] != title or title in matched:
                    raise ValueError("column_title_ambiguous_or_changed")
                matched[title] = token
        if page["paging"]["is_end"] is True:
            return [{"id": token, "title": title} for title, token in sorted(matched.items())]
        if not items:
            break
        offset += len(items)
    raise ValueError("column_listing_incomplete")


def series_stats(client, column_id):
    check_column(client, column_id)
    column = client._get(f"https://zhuanlan.zhihu.com/api/columns/{column_id}")
    count = column.get("articles_count")
    if not isinstance(count, int) or not 0 <= count <= 10000:
        raise ValueError("series_count_invalid")
    articles = []
    while len(articles) < count:
        page = client._get(f"https://zhuanlan.zhihu.com/api/columns/{column_id}/articles", {"limit": 20, "offset": len(articles)})
        page = page if isinstance(page, list) else page.get("data", [])
        if not page:
            raise ValueError("series_pagination_incomplete")
        articles.extend(page)
    ids = [str(article.get("id", "")) for article in articles]
    if len(set(ids)) != len(ids) or len(ids) != count:
        raise ValueError("series_listing_changed")
    ordinals = []
    for article in articles:
        match = re.search(r"（第(\d+)\s*篇\s*\|\s*day\s*\d+）$", article.get("title", ""))
        if match:
            ordinals.append(int(match[1]))
    return {"publishedCount": count, "maxOrdinal": max(ordinals, default=0)}


def read_draft(client, article_id):
    if not re.fullmatch(r"\d+", article_id):
        raise ValueError("invalid_draft_id")
    url = f"https://zhuanlan.zhihu.com/api/articles/{article_id}/draft"
    response = client._session.get(url, timeout=15)
    if response.status_code == 404:
        article = client._get(url.removesuffix("/draft"))
    elif response.status_code == 200:
        article = response.json()
    else:
        raise ValueError("draft_read_failed")
    html = article.get("content", "") or ""
    return {"id": str(article.get("id", "")), "authorId": article.get("author", {}).get("id", ""),
            "title": article.get("title", "") or "", "text": normalize(html), "format": format_structure(html),
            "state": article.get("state", ""), "tableOfContents": catalog_setting(article),
            "editorUrl": f"https://zhuanlan.zhihu.com/p/{article_id}/edit"}


def create_draft(client):
    response = client._session.post("https://zhuanlan.zhihu.com/api/articles/drafts", json={}, timeout=15)
    if response.status_code != 200:
        raise ValueError("draft_create_failed")
    return {"id": article_id_from_result(response.json())}


def write_draft(client, article_id, title, html, account_id, expected):
    current = read_draft(client, article_id)
    if current["authorId"] != account_id or current["state"] != "draft":
        raise ValueError("draft_identity_or_state_changed")
    if any(current[key] != expected[key] for key in ("title", "text", "format")):
        raise ValueError("cloud_draft_edited")
    catalog = has_catalog_headings(html)
    response = client._session.patch(f"https://zhuanlan.zhihu.com/api/articles/{article_id}/draft", json={"title": title, "content": html, "table_of_contents": catalog}, timeout=15)
    if response.status_code != 200:
        raise ValueError("draft_save_failed")
    saved = read_draft(client, article_id)
    if saved["tableOfContents"] != catalog:
        raise ValueError("article_table_of_contents_readback_mismatch")
    expected_format = format_structure(html)
    if saved["format"] != expected_format:
        expected_cards = [b for b in json.loads(expected_format)["blocks"] if b["kind"] == "card"]
        saved_cards = [b for b in json.loads(saved["format"])["blocks"] if b["kind"] == "card"]
        if expected_cards != saved_cards:
            raise ValueError("article_link_card_readback_mismatch")
    if saved["title"] != title or saved["text"] != normalize(html) or saved["format"] != expected_format or saved["state"] != "draft":
        raise ValueError("draft_readback_mismatch")
    return saved


def publish_saved_draft(client, article_id, title, html, column_id, account_id, expected, column_ids=None):
    for token in column_ids if column_ids is not None else [column_id]:
        check_column(client, token)
    write_draft(client, article_id, title, html, account_id, expected)
    return publish_article_content(client, article_id, title, html, column_id, columns=column_ids)


def publish_article_content(client, article_id, title, html, column_id, is_published=False, columns=None):
    columns = columns if columns is not None else [column_id]
    for token in columns:
        check_column(client, token)
    # Match the current first-party editor's article payload. The pinned
    # client's text-only create_article branch still uses a retired endpoint.
    visible = VisibleText()
    visible.feed(html)
    result = client._content_publish({
        "action": "article",
        "data": {
            "extra_info": {"publisher": "pc"},
            "draft": {"disabled": 1, "id": article_id, "isPublished": is_published},
            "column": {"column": columns},
            "commentsPermission": {"comment_permission": "anyone"},
            "creationStatement": {"disclaimer_type": "none", "disclaimer_status": "close"},
            "contentsTables": {"table_of_contents_enabled": has_catalog_headings(html)},
            "commercialReportInfo": {"isReport": 0},
            "appreciate": {"can_reward": False, "tagline": ""},
            "hybrid": {"html": html, "textLength": len("".join(visible.parts).encode("utf-16-le")) // 2},
            "title": {"title": title},
        },
    })
    published = result.get("publish", {})
    if published.get("id") and str(published["id"]) != article_id:
        raise ValueError("published_draft_id_changed")
    # The original ID is durable; the caller must verify published state, full
    # content and accepted column membership before treating this as success.
    return {"id": article_id}


def publish_in_column(client, title, html, column_id):
    check_column(client, column_id)
    created = create_draft(client)
    before = read_draft(client, created["id"])
    if before["state"] != "draft" or before["title"] or before["text"]:
        raise ValueError("new_publish_draft_not_empty")
    return publish_saved_draft(client, created["id"], title, html, column_id, before["authorId"], before)

def revision_columns(actual, before, primary):
    expected = accepted_column_ids(before)
    if (expected and primary not in expected) or (not expected and primary) or accepted_column_ids(actual) != expected:
        raise ValueError('revision_public_columns_changed')
    if not expected:
        return []
    return [primary, *(column for column in expected if column != primary)]


def update_published(client, request, account_id):
    article_id=request['articleId']
    if not re.fullmatch(r'\d+',article_id):raise ValueError('invalid_article_id')
    actual=client._get(f'https://zhuanlan.zhihu.com/api/articles/{article_id}')
    before=request['expectedPublic']
    if str(actual.get('id'))!=article_id or actual.get('author',{}).get('id')!=account_id or actual.get('state')!='published':
        raise ValueError('revision_public_identity_changed')
    if actual['title']!=before['title'] or normalize(actual['content'])!=normalize(before['content']) or format_structure(actual['content'])!=format_structure(before['content']) or catalog_setting(actual)!=catalog_setting(before):
        raise ValueError('revision_public_changed')
    # Preserve unsupported public settings by stopping instead of resetting them.
    if actual.get('title_image') or actual.get('comment_permission') not in (None,'all') or actual.get('creation_statement'):
        raise ValueError('revision_public_settings_require_review')
    columns = revision_columns(actual, before, request['columnId'])
    if len(columns) > 1:
        editor = client._get(f'https://zhuanlan.zhihu.com/api/articles/{article_id}/draft')
        selected = editor.get('column')
        if isinstance(selected, dict):
            selected = [selected]
        editor_columns = sorted(str(col.get('url_token') or col.get('id')) if isinstance(col, dict) else str(col)
                                for col in selected) if isinstance(selected, list) else []
        if (str(editor.get('id')) != article_id or editor.get('author', {}).get('id') != account_id
                or editor.get('state') != 'published' or editor_columns not in (sorted(columns), columns[:1])
                or editor.get('title') != actual['title'] or normalize(editor.get('content', '')) != normalize(actual['content'])
                or format_structure(editor.get('content', '')) != format_structure(actual['content'])
                or catalog_setting(editor) != catalog_setting(actual)):
            raise ValueError('revision_editor_changed')
        # Some editor responses expose only the primary selection. Keep the full
        # public set in the durable revision; readback will restore any missing items.
        if editor_columns == columns[:1]:
            columns = columns[:1]
    preview=read_draft(client,request['previewId'])
    if preview['authorId']!=account_id or preview['state']!='draft' or any(preview[k]!=request['expectedPreview'][k] for k in ('title','text','format','tableOfContents')):
        raise ValueError('revision_preview_changed')
    if preview['title']!=request['title'] or preview['text']!=normalize(request['html']) or preview['format']!=format_structure(request['html']):
        raise ValueError('revision_approval_changed')
    validate_links(request['html'])
    return publish_article_content(client, article_id, request['title'], request['html'], request['columnId'],
                                   is_published=True, columns=columns)


def restore_revision_column(client, request, account_id):
    article_id, target = request['articleId'], request['targetColumn']
    before, prepared = request['expectedPublic'], request['prepared']
    expected = accepted_column_ids(before)
    if target not in expected or target == request['columnId']:
        raise ValueError('revision_column_restore_outside_original_set')
    check_column(client, target)
    article = read_article(client, article_id)
    if (article['id'] != article_id or article['authorId'] != account_id
            or any(article[key] != prepared[key] for key in ('title','text','format','tableOfContents'))):
        raise ValueError('revision_column_restore_public_changed')
    current = article['columnIds']
    if request['columnId'] not in current or not set(current).issubset(expected):
        raise ValueError('revision_column_restore_membership_changed')
    if target not in current:
        response = client._session.post(f'https://www.zhihu.com/api/v4/columns/{target}/items',
                                       json={'type': 'article', 'id': article_id}, timeout=15)
        if response.status_code not in (200, 201, 204):
            raise ValueError('revision_column_restore_unconfirmed')
    return {'id': article_id}


def main(request):
    action = request["action"]
    if action == "prepare":
        with ExitStack() as stack:
            client = None

            def checked_client():
                nonlocal client
                if client is None:
                    client = stack.enter_context(load_client(request["snapshotPath"], article_images=request.get("diagramMode") in ("upload", "cache")))
                    if client.get_self_info().get("id") != request["expectedAccountId"]:
                        raise ValueError("account_changed")
                return client

            diagrams = diagram_images(request["nodes"], request.get("diagrams"), request.get("diagramMode", "cache"),
                                      lambda path: upload_article_image(checked_client(), path),
                                      lambda image_id: read_article_image(checked_client(), image_id))
            base = prepare_layout(request["nodes"], request.get("firstPublishedAt"), request.get("aiGeneratedTagRemId"), diagrams)
            names = mention_names(base["html"])
            bindings = resolve_mentions(checked_client(), names, request.get("mentionBindings", [])) if names else []
            result = prepare(request["nodes"], request.get("firstPublishedAt"), request.get("aiGeneratedTagRemId"), bindings, request.get("seriesLabel"), diagrams)
        validate_links(result["html"])
        return result
    with load_client(request["snapshotPath"]) as client:
        me = client.get_self_info()
        account = {"id": me.get("id", ""), "name": me.get("name", ""),
                   "urlToken": me.get("url_token", "")}
        if not account["id"] or not account["urlToken"]:
            raise ValueError("zhihu_account_unverified")
        if action == "check":
            return {**account, **(check_column(client, request["columnId"]) if request.get("columnId") else {})}
        if account["id"] != request["expectedAccountId"]:
            raise ValueError("zhihu_account_changed")
        if action == "series":
            return series_stats(client, request["columnId"])
        if action == "columns-for-tags":
            return columns_for_tags(client, account["urlToken"], request["tags"])
        if action == "create-draft":
            if request.get("columnId"):
                check_column(client, request["columnId"])
            return create_draft(client)
        if action == "read-draft":
            return read_draft(client, request["articleId"])
        if action == "write-draft":
            return write_draft(client, request["articleId"], request["title"], request["html"], account["id"], request["expected"])
        if action == 'update-published':
            return update_published(client,request,account['id'])
        if action == 'restore-revision-column':
            return restore_revision_column(client, request, account['id'])
        if action == "publish":
            if request.get("draftId"):
                return publish_saved_draft(client, request["draftId"], request["title"], request["html"], request.get("columnId"), account["id"], request["expected"], request.get("columnIds"))
            # One attempt only. The caller persists an unknown-result fence before this call.
            result = publish_in_column(client, request["title"], request["html"], request["columnId"])
            return {"id": article_id_from_result(result)}
        if action == "verify":
            return read_article(client, request["articleId"])
        raise ValueError("unsupported_action")


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "data": main(json.load(sys.stdin))}, ensure_ascii=False))
    except Exception as error:
        # Upstream exceptions can include response bodies; expose class or our fixed codes only.
        code = str(error) if type(error) is ValueError else type(error).__name__
        print(json.dumps({"ok": False, "error": code}))
        sys.exit(1)
