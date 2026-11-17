// What a Markdown document looks like once the app has rendered it.
const { test, expect, openApp, openMarkdown, openFiles, appErrors, view, rerender, statusText } = require('./helpers');

test.beforeEach(async ({ page }) => { await openApp(page); });

// Rendering an ordinary document must never raise an error in the page.
test.afterEach(async ({ page }) => { expect(appErrors(page)).toEqual([]); });

const backgroundOf = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
// 1x1 transparent PNG
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test.describe('GitHub Flavored Markdown', () => {
  test('headings become h1-h6 with ids generated from their text', async ({ page }) => {
    await openMarkdown(page, '# Getting Started\n\n## Step 2: Install & Run\n\n###### Deep');
    await expect(view(page).locator('h1')).toHaveText('Getting Started');
    await expect(view(page).locator('h1')).toHaveId('getting-started');
    await expect(view(page).locator('h2')).toHaveId('step-2-install--run');
    await expect(view(page).locator('h6')).toHaveId('deep');
  });

  test('headings with the same text get distinct ids', async ({ page }) => {
    await openMarkdown(page, '# Notes\n\n## Notes\n\n## Notes');
    const ids = await view(page).locator('h1, h2').evaluateAll((hs) => hs.map((h) => h.id));
    expect(ids).toEqual(['notes', 'notes-1', 'notes-2']);
  });

  test('paragraphs, emphasis, strong and inline code are rendered', async ({ page }) => {
    await openMarkdown(page, 'First *em* and **strong** and `code`.\n\nSecond paragraph.');
    await expect(view(page).locator('p')).toHaveCount(2);
    await expect(view(page).locator('p em')).toHaveText('em');
    await expect(view(page).locator('p strong')).toHaveText('strong');
    await expect(view(page).locator('p code')).toHaveText('code');
    await expect(view(page).locator('p').nth(1)).toHaveText('Second paragraph.');
  });

  test('a table is rendered with header cells, body cells and column alignment', async ({ page }) => {
    await openMarkdown(page, '| Name | Qty |\n|:-----|----:|\n| Apple | 3 |\n| Pear | 12 |');
    const table = view(page).locator('table');
    await expect(table.locator('thead th')).toHaveText(['Name', 'Qty']);
    await expect(table.locator('tbody tr')).toHaveCount(2);
    await expect(table.locator('tbody tr').nth(1).locator('td')).toHaveText(['Pear', '12']);
    await expect(table.locator('tbody td').nth(0)).toHaveAttribute('align', 'left');
    await expect(table.locator('tbody td').nth(1)).toHaveAttribute('align', 'right');
  });

  test('task list items show disabled checkboxes, ticked where the source says so', async ({ page }) => {
    await openMarkdown(page, '- [x] done\n- [ ] to do\n- plain item');
    const boxes = view(page).locator('li input[type="checkbox"]');
    await expect(boxes).toHaveCount(2);
    await expect(boxes.nth(0)).toBeChecked();
    await expect(boxes.nth(1)).not.toBeChecked();
    await expect(boxes.nth(0)).toBeDisabled();
    await expect(boxes.nth(1)).toBeDisabled();
    await expect(view(page).locator('li')).toHaveCount(3);
  });

  test('~~text~~ is struck through', async ({ page }) => {
    await openMarkdown(page, 'This is ~~wrong~~ right.');
    await expect(view(page).locator('del')).toHaveText('wrong');
  });

  test('bare URLs and www addresses become links', async ({ page }) => {
    await openMarkdown(page, 'See https://example.com/page and www.example.org for more.');
    const links = view(page).locator('a');
    await expect(links).toHaveCount(2);
    await expect(links.nth(0)).toHaveAttribute('href', 'https://example.com/page');
    await expect(links.nth(1)).toHaveAttribute('href', 'http://www.example.org');
  });

  test('an image with a data: URL is displayed', async ({ page }) => {
    await openMarkdown(page, `![a pixel](${PIXEL})`);
    const img = view(page).locator('img');
    await expect(img).toHaveAttribute('alt', 'a pixel');
    await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth)).toBe(1);
  });
});

test.describe('links', () => {
  test('external links open in a new window without access to the app', async ({ page }) => {
    await openMarkdown(page, '[web](https://example.com/) and [mail](mailto:someone@example.com)');
    for (const name of ['web', 'mail']) {
      const link = view(page).getByRole('link', { name });
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /\bnoopener\b/);
    }
    await expect(view(page).getByRole('link', { name: 'web' })).toHaveAttribute('href', 'https://example.com/');
  });

  test('a link to a heading in the same document is not given target=_blank', async ({ page }) => {
    await openMarkdown(page, '[jump](#the-end)\n\n# The End');
    const link = view(page).getByRole('link', { name: 'jump' });
    await expect(link).toHaveAttribute('href', '#the-end');
    await expect(link).not.toHaveAttribute('target');
    await expect(link).not.toHaveClass(/unresolved/);
  });

  test('clicking a link to a heading scrolls to it and stays in the app', async ({ page }) => {
    const filler = Array.from({ length: 120 }, (_, i) => `Line ${i}`).join('\n\n');
    await openMarkdown(page, `[jump](#the-end)\n\n${filler}\n\n# The End\n\n${filler}`);
    const heading = view(page).locator('#the-end');
    await expect(heading).not.toBeInViewport();
    const url = page.url();

    await view(page).getByRole('link', { name: 'jump' }).click();

    await expect(heading).toBeInViewport();
    expect(page.url()).toBe(url);
    await expect(heading).toHaveText('The End');   // the document is still shown
  });

  test('a link to a heading whose id equals an app element id scrolls to the heading', async ({ page }) => {
    // "# View" gets id="view", the same id as the app's own <main id="view">.
    const filler = Array.from({ length: 120 }, (_, i) => `Line ${i}`).join('\n\n');
    await openMarkdown(page, `[jump](#view)\n\n${filler}\n\n# View\n\n${filler}`);
    const heading = view(page).locator('h1');
    await expect(heading).not.toBeInViewport();

    await view(page).getByRole('link', { name: 'jump' }).click();

    await expect(heading).toBeInViewport();
  });

  test('a relative link is marked as unresolved and explains why in its tooltip', async ({ page }) => {
    await openMarkdown(page, '[other](other.md) and [deep](docs/guide.md#intro)');
    const link = view(page).getByRole('link', { name: 'other' });
    await expect(link).toHaveClass(/\bunresolved\b/);
    await expect(link).toHaveAttribute('title', /other\.md/);
    await expect(link).not.toHaveAttribute('target');
    await expect(view(page).getByRole('link', { name: 'deep' })).toHaveClass(/\bunresolved\b/);
  });

  test('clicking a relative link does not navigate and shows a status message', async ({ page }) => {
    await openMarkdown(page, '# Title\n\n[other](other.md)');
    const url = page.url();
    expect(await statusText(page)).toBe('');

    await view(page).getByRole('link', { name: 'other' }).click();

    await expect(page.locator('#status')).toContainText('other.md');
    expect(page.url()).toBe(url);
    await expect(view(page).locator('h1')).toHaveText('Title');
  });
});

test.describe('code blocks', () => {
  test('a fenced block in a known language is syntax-highlighted', async ({ page }) => {
    await openMarkdown(page, '```js\nconst answer = 42; // comment\n```');
    const code = view(page).locator('pre > code');
    await expect(code).toHaveClass(/\bhljs\b/);
    await expect(code.locator('.hljs-keyword')).toHaveText('const');
    await expect(code.locator('.hljs-number')).toHaveText('42');
    await expect(code.locator('.hljs-comment')).toHaveText('// comment');
    await expect(code).toHaveText('const answer = 42; // comment\n');
  });

  test('a fenced block in an unknown language is shown as plain text', async ({ page }) => {
    await openMarkdown(page, '```nosuchlang\nconst answer = 42;\n```');
    const code = view(page).locator('pre > code');
    await expect(code).toHaveText('const answer = 42;\n');
    await expect(code).not.toHaveClass(/\bhljs\b/);
    await expect(code.locator('span')).toHaveCount(0);
  });

  test('a fenced block without a language is shown as plain text', async ({ page }) => {
    await openMarkdown(page, '```\nconst answer = 42;\n<b>not bold</b>\n```');
    const code = view(page).locator('pre > code');
    await expect(code).toHaveText('const answer = 42;\n<b>not bold</b>\n');
    await expect(code).not.toHaveClass(/\bhljs\b/);
    await expect(code.locator('*')).toHaveCount(0);
  });
});

test.describe('math', () => {
  test('$...$ is typeset inline', async ({ page }) => {
    await openMarkdown(page, 'Euler: $e^{i\\pi} + 1 = 0$ is famous.');
    const math = view(page).locator('p .katex');
    await expect(math).toHaveCount(1);
    await expect(view(page).locator('.katex-display')).toHaveCount(0);
    await expect(math.locator('annotation')).toHaveText('e^{i\\pi} + 1 = 0');
    await expect(view(page).locator('.katex-error')).toHaveCount(0);
    await expect(view(page).locator('p')).not.toContainText('$');
  });

  test('$$...$$ is typeset as a display block', async ({ page }) => {
    await openMarkdown(page, 'Before\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\nAfter');
    const display = view(page).locator('.katex-display');
    await expect(display).toHaveCount(1);
    await expect(display.locator('.mfrac')).toHaveCount(1);
    await expect(view(page).locator('.katex-error')).toHaveCount(0);
  });

  test('a ```math fenced block is typeset as a display block, not shown as code', async ({ page }) => {
    await openMarkdown(page, '```math\n\\sqrt{a^2 + b^2}\n```');
    await expect(view(page).locator('.katex-display')).toHaveCount(1);
    await expect(view(page).locator('.katex-display .sqrt')).toHaveCount(1);
    await expect(view(page).locator('pre')).toHaveCount(0);
  });

  // Regression: the sanitizer drops attributes whose value contains "]>",
  // "-->" or "</", and the formula source used to travel in one unencoded.
  for (const [what, source, expected] of [
    ['"]>" (inline)', 'Check $a[i]>0$ here.', 'a[i]>0'],
    ['"-->" (inline)', 'Check $x --> y$ here.', 'x --> y'],
    ['"]>" (display)', '$$\nb[1]>c\n$$', 'b[1]>c'],
  ]) {
    test(`math containing ${what} is typeset, not dropped`, async ({ page }) => {
      await openMarkdown(page, source);
      await expect(view(page).locator('.katex annotation')).toHaveText(expected, { timeout: 2_000 });
    });
  }

  test('dollar amounts such as "$5 and $10" are left as text', async ({ page }) => {
    await openMarkdown(page, 'It costs $5 and $10 respectively.');
    await expect(view(page).locator('p')).toHaveText('It costs $5 and $10 respectively.');
    await expect(view(page).locator('.katex, .math')).toHaveCount(0);
  });
});

test.describe('Mermaid diagrams', () => {
  const DIAGRAM = '```mermaid\ngraph TD\n  Start --> Finish\n```';

  test('a ```mermaid block is drawn as an SVG diagram', async ({ page }) => {
    await openMarkdown(page, `# Flow\n\n${DIAGRAM}`);
    const svg = view(page).locator('.mermaid-diagram svg');
    await expect(svg).toHaveCount(1);
    await expect(svg).toBeVisible();
    await expect(svg).toContainText('Start');
    await expect(svg).toContainText('Finish');
    await expect(view(page).locator('pre')).toHaveCount(0);   // the source is replaced
  });

  test('an invalid mermaid block shows an error message and keeps its source', async ({ page }) => {
    await openMarkdown(page, '```mermaid\nthis is not a diagram\n```\n\nAfter');
    await expect(view(page).locator('.render-error')).toHaveText(/^Mermaid: .+/);
    await expect(view(page).locator('pre > code')).toHaveText('this is not a diagram\n');
    await expect(view(page).locator('.mermaid-diagram')).toHaveCount(0);
    await expect(view(page).locator('p').last()).toHaveText('After');
    // Mermaid's own error graphic must not be left behind in the page.
    await expect(page.locator('body > [id^="dmermaid"], body > svg')).toHaveCount(0);
  });

  test('an invalid mermaid block does not stop a later valid one from being drawn', async ({ page }) => {
    await openMarkdown(page, `\`\`\`mermaid\nnope\n\`\`\`\n\n${DIAGRAM}`);
    await expect(view(page).locator('.render-error')).toHaveCount(1);
    await expect(view(page).locator('.mermaid-diagram svg')).toHaveCount(1);
  });

  test('mermaid source is not run through the syntax highlighter', async ({ page }) => {
    // The source stays visible only when the diagram is invalid.
    await openMarkdown(page, '```mermaid\ngraph TD\n  A --> --> "unterminated\n```');
    const code = view(page).locator('pre > code.language-mermaid');
    await expect(code).toHaveCount(1);
    await expect(code).not.toHaveClass(/\bhljs\b/);
    await expect(code.locator('span')).toHaveCount(0);
  });
});

test.describe('colour scheme', () => {
  test('the page background is light in a light scheme and dark in a dark scheme', async ({ page }) => {
    await openMarkdown(page, '# Title');
    await page.emulateMedia({ colorScheme: 'light' });
    expect(await backgroundOf(page)).toBe('rgb(255, 255, 255)');
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await backgroundOf(page)).toBe('rgb(13, 17, 23)');
  });

  test('switching to dark redraws diagrams in the dark theme and keeps the document', async ({ page }) => {
    await openFiles(page, [{
      name: 'flow.md',
      content: '# Flow\n\nSome text.\n\n```mermaid\ngraph TD\n  Start --> Finish\n```\n\n```js\nlet x = 1;\n```',
    }]);
    const svg = view(page).locator('.mermaid-diagram svg');
    // Mermaid numbers its element ids per rendering; ignore that difference.
    const drawing = async () => (await svg.innerHTML()).replace(/mermaid-\d+-\d+/g, 'mermaid-N');
    const lightSvg = await drawing();

    await rerender(page, () => page.emulateMedia({ colorScheme: 'dark' }));

    await expect(svg).toHaveCount(1);
    await expect(svg).toContainText('Start');
    expect(await drawing()).not.toBe(lightSvg);   // different theme colours
    await expect(view(page).locator('h1')).toHaveText('Flow');
    await expect(view(page).locator('p').first()).toHaveText('Some text.');
    await expect(view(page).locator('pre > code .hljs-keyword')).toHaveText('let');
    await expect(view(page).locator('pre > code.language-mermaid')).toHaveCount(0);
    await expect(page).toHaveTitle('flow.md');

    await rerender(page, () => page.emulateMedia({ colorScheme: 'light' }));
    expect(await drawing()).toBe(lightSvg);
  });
});
