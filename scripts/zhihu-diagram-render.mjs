import { createRequire } from 'node:module';
import path from 'node:path';

async function main() {
    const input = [];
    for await (const part of process.stdin) input.push(part);
    const { modules, browserExecutable, mermaidVersion, playwrightVersion, diagram, output } =
        JSON.parse(Buffer.concat(input).toString('utf8'));
    if (![modules, browserExecutable, output].every(path.isAbsolute) || typeof diagram !== 'string') {
        throw Error('invalid diagram renderer configuration');
    }
    const require = createRequire(path.join(modules, 'package.json'));
    if (require(path.join(modules, 'node_modules/mermaid/package.json')).version !== mermaidVersion ||
        require(path.join(modules, 'node_modules/playwright/package.json')).version !== playwrightVersion) {
        throw Error('diagram renderer version changed');
    }
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1640, height: 1400 }, deviceScaleFactor: 2 });
        await page.route('**/*', route => route.abort());
        await page.setContent('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:white}#diagram{display:inline-block;padding:16px;vertical-align:top}svg{display:block}</style><div id="diagram"></div>');
        await page.addScriptTag({ path: path.join(modules, 'node_modules/mermaid/dist/mermaid.min.js') });
        await page.evaluate(async source => {
            const host = document.getElementById('diagram');
            mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default',
                fontFamily: 'Microsoft YaHei, Noto Sans CJK SC, Segoe UI, sans-serif', suppressErrorRendering: true });
            const { svg } = await mermaid.render('zhihu-mermaid', source);
            host.innerHTML = svg;
            const graphic = host.querySelector('svg');
            const { width, height } = graphic.viewBox.baseVal;
            if (!width || !height || width > 10000 || height > 14000) throw Error('invalid diagram bounds');
            const scale = Math.min(1.25, 1500 / width, 2100 / height);
            graphic.style.maxWidth = 'none';
            graphic.style.width = `${Math.ceil(width * scale)}px`;
            graphic.style.height = `${Math.ceil(height * scale)}px`;
            await document.fonts.ready;
        }, diagram);
        await page.locator('#diagram').screenshot({ path: output, type: 'png', timeout: 15000 });
    } finally {
        await browser.close();
    }
}

main().catch(() => {
    process.stderr.write('Mermaid rendering failed\n');
    process.exitCode = 1;
});
