// Reusable, transparent vector artwork redrawn from the supplied candy swatches.
(() => {
  const patterns = {
    'cream-pink-dot': ['奶油黄粉波点', 'hearts', '#fff5bc', '#ee94b7', 114, 16],
    'pink-picnic': ['粉色野餐格', 'plaid', '#fff3e9', '#f2adcc'],
    lavender: ['薰衣草田', 'flowers', '#b6a6c8', '#fff6cc', 126, '#e2c25a'],
    matcha: ['抹茶棋盘格', 'checker', '#f7f3d9', '#a4b089'],
    'blue-cocoa': ['蓝色可可波点', 'dots', '#dbf0f5', '#a67e68', 103, 9],
    'strawberry-milk': ['草莓牛奶', 'dots', '#7eb3e0', '#fff8ed', 118, 19],
    'lemon-soda': ['柠檬苏打', 'stripe', '#fff2ac', '#e7c653', 110, 43],
    'grape-checker': ['葡萄棋盘格', 'checker', '#f2e9f5', '#b8a1cd'],
    'peach-heart': ['桃子心动', 'hearts', '#f6d2bb', '#df8494', 118, 41],
    'strawberry-star': ['草莓奶星', 'stars', '#f3b6d7', '#fff1b7', 150, 35],
    'grape-dot': ['葡萄大波点', 'dots', '#aa80c6', '#fff4df', 205, 46],
    'peach-sorbet': ['蜜桃沙冰', 'stripe', '#ffe7db', '#edada0', 123, 48],
    daisy: ['雏菊花园', 'flowers', '#a6b799', '#fff6db', 142, '#e2b74e'],
    'pink-flower': ['粉色小花', 'flowers', '#edb7cf', '#fff9dd', 143, '#e7cd5c'],
    'blue-letter': ['蓝色情书', 'hearts', '#aecfdf', '#fff8e3', 121, 44],
    'night-stars': ['星河晚安', 'stars', '#787399', '#f8e4a0', 130, 38],
    'purple-heart': ['紫色心事', 'hearts', '#c9b7da', '#fff3d5', 125, 42],
    'cherry-letter': ['樱桃情书', 'hearts', '#fff1e4', '#ce5572', 118, 45],
    'cream-garden': ['奶油花圃', 'flowers', '#f9e3af', '#bc8eb9', 142, '#e2be4f'],
    sunflower: ['向日葵大波点', 'dots', '#eabf3f', '#fff8dd', 210, 49],
  };
  const heart = 'M500 180C500 80 420 0 285 0C120 0 0 110 0 265C0 510 260 725 500 950C740 725 1000 510 1000 265C1000 110 880 0 715 0C580 0 500 80 500 180Z';
  function polygon(points) { return `<polygon points="${points.map(p => p.join(',')).join(' ')}"/>`; }
  function star(cx, cy, outer, inner) {
    return Array.from({ length: 10 }, (_, i) => {
      const angle = -Math.PI / 2 + i * Math.PI / 5, radius = i % 2 ? inner : outer;
      return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];
    });
  }
  function bounded(points) {
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    return { box: [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)], body: polygon(points) };
  }
  function lobes(count, depth) {
    return bounded(Array.from({ length: 720 }, (_, i) => {
      const angle = i / 720 * Math.PI * 2, r = 500 - depth + depth * Math.cos(count * angle);
      return [500 + r * Math.cos(angle), 500 + r * Math.sin(angle)];
    }));
  }
  const shapes = {
    circle: { box: [0, 0, 1000, 1000], body: '<circle cx="500" cy="500" r="500"/>' },
    heart: { box: [0, 0, 1000, 950], body: `<path d="${heart}"/>` },
    star: bounded(star(500, 500, 500, 220)),
    flower: lobes(6, 68),
    scallop: lobes(14, 19),
  };
  const labels = { circle: '圆形', heart: '爱心', star: '五角星', flower: '小花', scallop: '波浪圆' };
  function texture([, kind, bg, fg, step = 140, detail]) {
    let body, width = step, transform = '';
    if (kind === 'checker') {
      width = 280;
      body = `<path d="M0 0H140V140H0ZM140 140H280V280H140Z" fill="${fg}"/>`;
    } else if (kind === 'plaid') {
      width = 240;
      body = `<g fill="${fg}" opacity=".75"><path d="M25 0H155V240H25Z"/><path d="M0 25H240V155H0Z"/></g><g stroke="#fff6f0" stroke-width="8" opacity=".9"><path d="M63 0V240M116 0V240M0 63H240M0 116H240"/></g>`;
    } else if (kind === 'stripe') {
      transform = ' patternTransform="rotate(-24)"';
      body = `<path d="M0 0H${detail}V${width}H0Z" fill="${fg}"/>`;
    } else {
      const mark = kind === 'dots' ? `<circle r="${detail}" fill="${fg}"/>` : kind === 'stars' ?
        `<g fill="${fg}">${polygon(star(0, 0, detail, detail * .44))}</g>` : kind === 'hearts' ?
          `<path d="${heart}" fill="${fg}" transform="translate(${-detail / 2},${-detail * .475}) scale(${detail / 1000})"/>` :
          `<g fill="${fg}">${Array.from({ length: 5 }, (_, i) => {
            const a = i * Math.PI * 2 / 5;
            return `<circle cx="${Math.sin(a) * 21}" cy="${Math.cos(a) * 21}" r="17"/>`;
          }).join('')}<circle r="12" fill="${detail}"/></g>`;
      // Staggered repeats keep the texture balanced at all cut edges.
      body = [[width / 4, width / 4], [width * .75, width * .75]].map(([x, y]) => `<g transform="translate(${x},${y})">${mark}</g>`).join('');
    }
    return `<pattern id="texture" patternUnits="userSpaceOnUse" width="${width}" height="${width}"${transform}><path d="M0 0H${width}V${width}H0Z" fill="${bg}"/>${body}</pattern>`;
  }
  function register(assets = {}) {
    const entries = {};
    const add = (keys, type, size) => keys.forEach(key => {
      const pattern = patterns[key], shape = shapes[type], [, , w, h] = shape.box;
      const id = `candy-${key}-${type}-${size}`, variant = `${size}mm`, baseName = `${pattern[0]}${labels[type]}`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(1200 * w / Math.max(w, h))}" height="${Math.round(1200 * h / Math.max(w, h))}" viewBox="${shape.box.join(' ')}"><defs>${texture(pattern)}</defs><g fill="url(#texture)">${shape.body}</g></svg>`;
      entries[id] = { name: `${baseName} · ${variant}`, baseName, patternName: pattern[0], variant, group: '缤纷糖果',
        type, w: Math.round(1200 * w / Math.max(w, h)), h: Math.round(1200 * h / Math.max(w, h)),
        nativeW: size * w / Math.max(w, h), nativeH: size * h / Math.max(w, h),
        frame: { x: .5, y: .5, w: 1, h: 1 }, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
    });
    add(['cream-pink-dot', 'pink-picnic', 'lavender', 'matcha'], 'circle', 20);
    add(['blue-cocoa', 'strawberry-milk', 'lemon-soda', 'grape-checker', 'peach-heart', 'cream-pink-dot'], 'heart', 20);
    for (const type of ['heart', 'star']) add(['strawberry-star', 'grape-dot', 'peach-sorbet', 'daisy'], type, 30);
    add(['pink-flower', 'blue-letter', 'peach-sorbet', 'night-stars', 'purple-heart'], 'flower', 30);
    add(['cherry-letter', 'cream-garden', 'lavender', 'sunflower'], 'scallop', 30);
    if (assets['ime-rose']) {
      for (const key of ['blue-cocoa', 'strawberry-milk', 'lemon-soda', 'grape-checker', 'peach-heart', 'cream-pink-dot', 'strawberry-star', 'grape-dot', 'peach-sorbet', 'daisy']) {
        const id = `ime-candy-${key}`, baseName = `${patterns[key][0]} I ♥ ME`;
        entries[id] = { ...assets['ime-rose'], name: `${baseName} · 原款`, baseName,
          src: `./assets/${id}.png` };
      }
    }
    return entries;
  }
  globalThis.HeartStarCandy = { register };
})();
