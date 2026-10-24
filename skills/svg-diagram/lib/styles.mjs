// 스타일 — 토큰(라이트 · 다크) + 생성기 인자(geo) + 그 스타일만의 그림 규칙.
// SVG 마크업은 스타일이 달라도 같다. 옷을 갈아입히는 일은 토큰 한 벌을 바꾸는 일이다.
// 시안(아홉 스타일 × 그림 넷): https://claude.ai/artifact/HXybPraHXYEhd544FDYyCM

export const DEFAULT_STYLE = null; // 미정 — 정해지면 key 를 적는다. 그때까지는 --style 또는 스펙의 style 이 있어야 한다.

const R16 = { title: 1.25, v: 1, k: 0.9, label: 0.95, tag: 0.85 }; // 글자 비율(기준 16px → 제목 20px). 2026-10-24 선택
const MONO =
  '"JetBrains Mono", "Nanum Gothic Coding", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const GF =
  "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Nanum+Gothic+Coding:wght@400;700";
const geo = (o = {}) => ({
  rx: 8,
  rxPill: 13,
  marker: "filled",
  markerSize: 9,
  titleBar: false,
  grid: null,
  u: 16,
  r: R16,
  textW: { ascii: 0.62, cjk: 1.02 },
  monoW: { ascii: 0.62, cjk: 1.1 },
  ...o,
});

export const STYLES = [
  {
    key: "editorial",
    name: "편집 지면",
    desc: "잡지 도판처럼. 고정폭 글꼴, 가는 선, 채움 없는 상자, 열린 화살촉. 색은 둘(청록 · 와인)만.",
    webfonts: GF,
    fonts: {
      diagram: '"JetBrains Mono", "Nanum Gothic Coding", monospace',
      mono: MONO,
    },
    stroke: { sw: 1, ew: 1.4, cap: "butt" },
    geo: geo({
      rx: 2,
      rxPill: 2,
      marker: "open",
      markerSize: 11,
      textW: { ascii: 0.62, cjk: 1.1 },
    }),
    tokens: {
      light: {
        bg: "#f5f3ee",
        surface: "#fffdf9",
        fg: "#1d1f24",
        muted: "#6b6a66",
        line: "#cfc9bd",
        stroke: "#1d1f24",
        ink2: "#3a3a3a",
        accent: "#1f5f5b",
        "accent-soft": "#fffdf9",
        blue: "#8a2a3a",
        "blue-soft": "#fffdf9",
        "io-soft": "#f1ece0",
        "ext-soft": "#f5f3ee",
        box: "#fffdf9",
        tag: "#ebe7df",
        "tag-fg": "#3a3a3a",
        bar: "#1d1f24",
        "on-bar": "#fffdf9",
        grid: "#cfc9bd",
      },
      dark: {
        bg: "#17181c",
        surface: "#1f2026",
        fg: "#e8e4da",
        muted: "#9b978f",
        line: "#3a3b42",
        stroke: "#e8e4da",
        ink2: "#c9c5bb",
        accent: "#6fc1b6",
        "accent-soft": "#1f2026",
        blue: "#d98a98",
        "blue-soft": "#1f2026",
        "io-soft": "#2a2822",
        "ext-soft": "#17181c",
        box: "#1f2026",
        tag: "#2b2c33",
        "tag-fg": "#c9c5bb",
        bar: "#e8e4da",
        "on-bar": "#17181c",
        grid: "#3a3b42",
      },
    },
    rules: `.d .t-title.on-lead { fill: var(--accent); } .d .lead { stroke-width: 1.4; }
.d .arr, .d .arr-b, .d .arr-a { fill: none; stroke-width: 1.2; }`,
  },
  {
    key: "blueprint",
    name: "청사진",
    desc: "도면처럼. 모눈 위에 각진 상자, 고정폭 글꼴, 열린 화살촉. 어두운 남색이 기본이고 라이트는 백사진이다.",
    webfonts: GF,
    fonts: {
      diagram: '"JetBrains Mono", "Nanum Gothic Coding", monospace',
      mono: MONO,
    },
    stroke: { sw: 1, ew: 1.4, cap: "square" },
    darkFirst: true,
    geo: geo({
      rx: 0,
      rxPill: 0,
      marker: "open",
      markerSize: 11,
      grid: "lines",
      textW: { ascii: 0.62, cjk: 1.1 },
    }),
    tokens: {
      light: {
        bg: "#eef3f9",
        surface: "#ffffff",
        fg: "#12325a",
        muted: "#5a7196",
        line: "#9fb6d6",
        stroke: "#1f4a7f",
        ink2: "#1f4a7f",
        accent: "#b7791f",
        "accent-soft": "#fff3d1",
        blue: "#0e7fa8",
        "blue-soft": "#dbf1fa",
        "io-soft": "#e5eef8",
        "ext-soft": "#f3f6fa",
        box: "#ffffff",
        tag: "#dde7f3",
        "tag-fg": "#12325a",
        bar: "#1f4a7f",
        "on-bar": "#ffffff",
        grid: "#d6e2f0",
      },
      dark: {
        bg: "#0e2a4f",
        surface: "#10325c",
        fg: "#e6f0ff",
        muted: "#9fb8d8",
        line: "#5f84b5",
        stroke: "#cfe0f7",
        ink2: "#cfe0f7",
        accent: "#ffd166",
        "accent-soft": "#3a3522",
        blue: "#7fe0ff",
        "blue-soft": "#15405c",
        "io-soft": "#173a66",
        "ext-soft": "#0e2a4f",
        box: "#10325c",
        tag: "#1a4273",
        "tag-fg": "#e6f0ff",
        bar: "#cfe0f7",
        "on-bar": "#0e2a4f",
        grid: "#1f4a7f",
      },
    },
    rules: `.d .t-title { font-weight: 700; letter-spacing: .02em; }
.d .arr, .d .arr-b, .d .arr-a { fill: none; stroke-width: 1.3; }
.d .ext { stroke-dasharray: 6 3 1 3; }`,
  },
  {
    key: "sketch",
    name: "손그림",
    desc: "화이트보드에 마커로 그린 것처럼. 손글씨 글꼴(Gaegu), 굵고 둥근 선, 스티커 색 채움, 상자마다 살짝 기울임. 기준 18px.",
    webfonts: GF + "&family=Gaegu:wght@400;700",
    fonts: { diagram: '"Gaegu", "Nanum Pen Script", cursive', mono: MONO },
    stroke: { sw: 2, ew: 2.5, cap: "round" },
    geo: geo({
      rx: 10,
      rxPill: 20,
      marker: "open",
      markerSize: 13,
      u: 18,
      textW: { ascii: 0.58, cjk: 1.0 },
    }),
    tokens: {
      light: {
        bg: "#fbfaf6",
        surface: "#ffffff",
        fg: "#2a2a2e",
        muted: "#6f6f76",
        line: "#dcdbd4",
        stroke: "#2a2a2e",
        ink2: "#2a2a2e",
        accent: "#2457c5",
        "accent-soft": "#fff3a3",
        blue: "#2e8b57",
        "blue-soft": "#ffd6e0",
        "io-soft": "#d9ecff",
        "ext-soft": "#f1f1ee",
        box: "#ffffff",
        tag: "#fff3a3",
        "tag-fg": "#2a2a2e",
        bar: "#2a2a2e",
        "on-bar": "#ffffff",
        grid: "#dcdbd4",
      },
      dark: {
        bg: "#1b2622",
        surface: "#22302b",
        fg: "#f1f0e6",
        muted: "#a8b3ac",
        line: "#3a4a43",
        stroke: "#f1f0e6",
        ink2: "#f1f0e6",
        accent: "#8ec5ff",
        "accent-soft": "#4a4420",
        blue: "#9be3b0",
        "blue-soft": "#4a2a35",
        "io-soft": "#2a3a4a",
        "ext-soft": "#22302b",
        box: "#22302b",
        tag: "#4a4420",
        "tag-fg": "#f1f0e6",
        bar: "#f1f0e6",
        "on-bar": "#1b2622",
        grid: "#3a4a43",
      },
    },
    rules: `.d .lead { stroke: var(--stroke); } .d .gate { stroke: var(--stroke); } .d .t-title.on-lead { fill: var(--fg); }
.d .arr, .d .arr-b, .d .arr-a { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.d .frame { stroke-width: 1.5; stroke-dasharray: 8 6; } .d .life { stroke-width: 1.5; }
.d .n { transform-box: fill-box; transform-origin: center; }
.d .n:nth-child(odd) { rotate: -.6deg; } .d .n:nth-child(even) { rotate: .5deg; }`,
  },
  {
    key: "product",
    name: "제품 화면",
    desc: "웹 제품의 설정 화면처럼. IBM Plex, 옅게 칠한 상자, 8px 모서리, 채운 화살촉.",
    webfonts: GF + "&family=IBM+Plex+Sans+KR:wght@400;500;600",
    fonts: {
      diagram:
        '"IBM Plex Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
      mono: MONO,
    },
    stroke: { sw: 1, ew: 1.6, cap: "butt" },
    geo: geo(),
    tokens: {
      light: {
        bg: "#f4f6f8",
        surface: "#ffffff",
        fg: "#1a2230",
        muted: "#5d6879",
        line: "#d2d9e2",
        stroke: "#d2d9e2",
        ink2: "#4b5667",
        accent: "#0f7a69",
        "accent-soft": "#dcf2ec",
        blue: "#2d61a6",
        "blue-soft": "#e3ecf9",
        "io-soft": "#f3efe2",
        "ext-soft": "#eef0f3",
        box: "#ffffff",
        tag: "#e8ecf1",
        "tag-fg": "#5d6879",
        bar: "#1a2230",
        "on-bar": "#ffffff",
        grid: "#d2d9e2",
      },
      dark: {
        bg: "#11161d",
        surface: "#1a2029",
        fg: "#e4e8ef",
        muted: "#98a3b5",
        line: "#2e3744",
        stroke: "#2e3744",
        ink2: "#aab4c3",
        accent: "#4fc2ad",
        "accent-soft": "#15302b",
        blue: "#82b1ea",
        "blue-soft": "#18283d",
        "io-soft": "#2d2a1f",
        "ext-soft": "#1f2630",
        box: "#1a2029",
        tag: "#262e3a",
        "tag-fg": "#98a3b5",
        bar: "#e4e8ef",
        "on-bar": "#11161d",
        grid: "#2e3744",
      },
    },
    rules: `.d .t-title.on-lead { fill: var(--accent); }`,
  },
  {
    key: "modern",
    name: "프리텐다드",
    desc: "요즘 한국어 제품처럼. Pretendard 에 파랑 하나, 분기는 호박색. Pretendard 는 Google Fonts 에 없어서 페이지가 @font-face 로 심어야 한다(시안은 부분집합 base64).",
    webfonts: GF,
    fonts: {
      diagram:
        '"Pretendard", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif',
      mono: MONO,
    },
    stroke: { sw: 1, ew: 1.6, cap: "butt" },
    geo: geo({ rx: 6, rxPill: 12, textW: { ascii: 0.6, cjk: 1.0 } }),
    tokens: {
      light: {
        bg: "#fafafa",
        surface: "#ffffff",
        fg: "#18181b",
        muted: "#71717a",
        line: "#e4e4e7",
        stroke: "#d4d4d8",
        ink2: "#3f3f46",
        accent: "#1d4ed8",
        "accent-soft": "#e0e9ff",
        blue: "#b45309",
        "blue-soft": "#fef3c7",
        "io-soft": "#f4f4f5",
        "ext-soft": "#fafafa",
        box: "#ffffff",
        tag: "#e4e4e7",
        "tag-fg": "#3f3f46",
        bar: "#18181b",
        "on-bar": "#ffffff",
        grid: "#e4e4e7",
      },
      dark: {
        bg: "#09090b",
        surface: "#18181b",
        fg: "#fafafa",
        muted: "#a1a1aa",
        line: "#27272a",
        stroke: "#3f3f46",
        ink2: "#d4d4d8",
        accent: "#60a5fa",
        "accent-soft": "#1e3a5f",
        blue: "#fbbf24",
        "blue-soft": "#3b2a0a",
        "io-soft": "#27272a",
        "ext-soft": "#18181b",
        box: "#18181b",
        tag: "#27272a",
        "tag-fg": "#d4d4d8",
        bar: "#fafafa",
        "on-bar": "#09090b",
        grid: "#27272a",
      },
    },
    rules: `.d .t-title.on-lead { fill: var(--accent); } .d .t-k { letter-spacing: -.01em; }`,
  },
  {
    key: "swiss",
    name: "스위스 단색",
    desc: "스위스 포스터처럼. 검정 하나에 강조색 하나(강조색은 미정 — 빨강 · 호박 기각), 굵은 고딕, 각진 상자, 제목 띠, 큰 채운 화살촉.",
    webfonts: GF + "&family=Noto+Sans+KR:wght@400;700;900",
    fonts: {
      diagram: '"Noto Sans KR", "Apple SD Gothic Neo", sans-serif',
      mono: MONO,
    },
    stroke: { sw: 1.5, ew: 2, cap: "butt" },
    geo: geo({
      rx: 0,
      rxPill: 0,
      marker: "filled",
      markerSize: 11,
      titleBar: true,
    }),
    tokens: {
      light: {
        bg: "#ffffff",
        surface: "#ffffff",
        fg: "#111111",
        muted: "#6e6e6e",
        line: "#cfcfcf",
        stroke: "#111111",
        ink2: "#111111",
        accent: "#b45309",
        "accent-soft": "#ffffff",
        blue: "#6e6e6e",
        "blue-soft": "#ffffff",
        "io-soft": "#ffffff",
        "ext-soft": "#f2f2f2",
        box: "#ffffff",
        tag: "#111111",
        "tag-fg": "#ffffff",
        bar: "#111111",
        "on-bar": "#ffffff",
        grid: "#cfcfcf",
      },
      dark: {
        bg: "#111111",
        surface: "#111111",
        fg: "#f2f2f2",
        muted: "#9a9a9a",
        line: "#3a3a3a",
        stroke: "#f2f2f2",
        ink2: "#f2f2f2",
        accent: "#fbbf24",
        "accent-soft": "#111111",
        blue: "#9a9a9a",
        "blue-soft": "#111111",
        "io-soft": "#111111",
        "ext-soft": "#1e1e1e",
        box: "#111111",
        tag: "#f2f2f2",
        "tag-fg": "#111111",
        bar: "#f2f2f2",
        "on-bar": "#111111",
        grid: "#3a3a3a",
      },
    },
    rules: `.d .t-title { font-weight: 700; } .d .t-title.on-bar { fill: var(--on-bar); }
.d .bar.gate { fill: var(--blue); } .d .t-tag { fill: var(--tag-fg); }
.d .gate, .d .lead, .d .io { stroke: var(--stroke); }
.d .edge.cond, .d .edge.ret { stroke-dasharray: 7 4; }`,
  },
  {
    key: "swissgrid",
    name: "스위스 + 모눈",
    desc: "스위스 단색의 색과 선 그대로에 청사진의 옅은 모눈만 깔았다.",
    webfonts: GF + "&family=Noto+Sans+KR:wght@400;700;900",
    fonts: {
      diagram: '"Noto Sans KR", "Apple SD Gothic Neo", sans-serif',
      mono: MONO,
    },
    stroke: { sw: 1.5, ew: 2, cap: "butt" },
    geo: geo({
      rx: 0,
      rxPill: 0,
      marker: "filled",
      markerSize: 11,
      titleBar: true,
      grid: "lines",
    }),
    tokens: {
      light: {
        bg: "#ffffff",
        surface: "#ffffff",
        fg: "#111111",
        muted: "#6e6e6e",
        line: "#cfcfcf",
        stroke: "#111111",
        ink2: "#111111",
        accent: "#b45309",
        "accent-soft": "#ffffff",
        blue: "#6e6e6e",
        "blue-soft": "#ffffff",
        "io-soft": "#ffffff",
        "ext-soft": "#f2f2f2",
        box: "#ffffff",
        tag: "#111111",
        "tag-fg": "#ffffff",
        bar: "#111111",
        "on-bar": "#ffffff",
        grid: "#e4e4e4",
      },
      dark: {
        bg: "#111111",
        surface: "#111111",
        fg: "#f2f2f2",
        muted: "#9a9a9a",
        line: "#3a3a3a",
        stroke: "#f2f2f2",
        ink2: "#f2f2f2",
        accent: "#fbbf24",
        "accent-soft": "#111111",
        blue: "#9a9a9a",
        "blue-soft": "#111111",
        "io-soft": "#111111",
        "ext-soft": "#1e1e1e",
        box: "#111111",
        tag: "#f2f2f2",
        "tag-fg": "#111111",
        bar: "#f2f2f2",
        "on-bar": "#111111",
        grid: "#262626",
      },
    },
    rules: `.d .t-title { font-weight: 700; } .d .t-title.on-bar { fill: var(--on-bar); }
.d .bar.gate { fill: var(--blue); } .d .t-tag { fill: var(--tag-fg); }
.d .gate, .d .lead, .d .io { stroke: var(--stroke); }
.d .edge.cond, .d .edge.ret { stroke-dasharray: 7 4; }`,
  },
  {
    key: "terminal",
    name: "터미널",
    desc: "모니터 인광처럼. 전부 고정폭, 점 모눈, 각진 상자, 꺾쇠 화살촉. 어두운 테마 하나.",
    webfonts: GF,
    fonts: {
      diagram: '"JetBrains Mono", "Nanum Gothic Coding", monospace',
      mono: MONO,
    },
    stroke: { sw: 1, ew: 1.4, cap: "square" },
    single: "dark",
    geo: geo({
      rx: 0,
      rxPill: 0,
      marker: "open",
      markerSize: 11,
      grid: "dots",
      textW: { ascii: 0.62, cjk: 1.1 },
    }),
    tokens: {
      light: {
        bg: "#0b0f0d",
        surface: "#0f1512",
        fg: "#b9f0c2",
        muted: "#5f8f6a",
        line: "#244631",
        stroke: "#6fcf8a",
        ink2: "#8fd9a0",
        accent: "#ffb454",
        "accent-soft": "#2a2112",
        blue: "#6cd4ff",
        "blue-soft": "#0f2a35",
        "io-soft": "#132019",
        "ext-soft": "#0f1512",
        box: "#0f1512",
        tag: "#1a3324",
        "tag-fg": "#b9f0c2",
        bar: "#6fcf8a",
        "on-bar": "#0b0f0d",
        grid: "#1b3526",
      },
      dark: null,
    },
    rules: `.d .t-title { font-weight: 700; } .d .t-title.on-lead { fill: var(--accent); }
.d .arr, .d .arr-b, .d .arr-a { fill: none; stroke-width: 1.4; }
.d .ext { stroke-dasharray: 2 3; } .d .edge.cond, .d .edge.ret { stroke-dasharray: 7 4; }`,
  },
  {
    key: "pastel",
    name: "파스텔 노트",
    desc: "노트 앱 캔버스처럼. 테두리 없이 파스텔로만 채운 둥근 상자, 둥근 고딕(Gowun Dodum).",
    webfonts: GF + "&family=Gowun+Dodum",
    fonts: { diagram: '"Gowun Dodum", "Noto Sans KR", sans-serif', mono: MONO },
    stroke: { sw: 0, ew: 2, cap: "round" },
    geo: geo({ rx: 12, rxPill: 22 }),
    tokens: {
      light: {
        bg: "#fbfaff",
        surface: "#ffffff",
        fg: "#3b3b4f",
        muted: "#8a8aa0",
        line: "#e6e4f0",
        stroke: "transparent",
        ink2: "#8b8fa3",
        accent: "#6f5bd6",
        "accent-soft": "#ece9fb",
        blue: "#3f9f7f",
        "blue-soft": "#dff5ec",
        "io-soft": "#fde9dc",
        "ext-soft": "#e3f0fb",
        box: "#f1f0f7",
        tag: "#ece9fb",
        "tag-fg": "#6f5bd6",
        bar: "#3b3b4f",
        "on-bar": "#ffffff",
        grid: "#e6e4f0",
      },
      dark: {
        bg: "#1b1b24",
        surface: "#242430",
        fg: "#e8e6f3",
        muted: "#9c9bb2",
        line: "#34344a",
        stroke: "transparent",
        ink2: "#a7a8c0",
        accent: "#b3a6ff",
        "accent-soft": "#35305a",
        blue: "#7fd6b5",
        "blue-soft": "#1f3d33",
        "io-soft": "#4a3328",
        "ext-soft": "#233448",
        box: "#2c2c3a",
        tag: "#35305a",
        "tag-fg": "#b3a6ff",
        bar: "#e8e6f3",
        "on-bar": "#1b1b24",
        grid: "#34344a",
      },
    },
    rules: `.d .t-title.on-lead { fill: var(--accent); } .d .exit { fill: var(--box); } .d .ext { stroke: var(--line); stroke-width: 1.5; }
.d .frame { stroke: var(--fg); stroke-width: 1.5; stroke-dasharray: none; }
.d .lane { fill: var(--surface); stroke: var(--line); stroke-width: 1; } .d .lane.alt { fill: var(--bg); }
.d .life { stroke: var(--fg); } .d .sep { stroke: var(--line); }`,
  },
  {
    key: "doc",
    name: "문서 따라감",
    desc: "토큰을 쓰는 HTML 문서 안에 넣을 때. 색 · 글꼴을 그 문서의 토큰(--ink · --line · --accent · --sans …)에서 받아 라이트 · 다크가 문서와 같이 바뀐다. 선 처리는 편집 지면과 같다.",
    webfonts: "",
    fonts: { diagram: "var(--sans)", mono: "var(--mono)" },
    stroke: { sw: 1, ew: 1.4, cap: "butt" },
    inherit: true, // 같은 이름의 토큰(bg · surface · line · accent · blue)은 문서 것을 그대로 쓴다
    geo: geo({ rx: 2, rxPill: 2, marker: "open", markerSize: 11 }),
    tokens: {
      light: {
        fg: "var(--ink)",
        muted: "var(--ink-3)",
        stroke: "var(--ink)",
        ink2: "var(--ink-2)",
        "accent-soft": "var(--accent-bg)",
        "blue-soft": "var(--blue-bg)",
        "io-soft": "var(--sunken)",
        "ext-soft": "var(--sunken)",
        box: "var(--surface)",
        tag: "var(--ink)",
        "tag-fg": "var(--surface)",
        bar: "var(--ink)",
        "on-bar": "var(--surface)",
        grid: "var(--line-soft)",
      },
      dark: null,
    },
    rules: `.d .t-title.on-lead { fill: var(--accent); } .d .lead { stroke-width: 1.4; }
.d .arr, .d .arr-b, .d .arr-a { fill: none; stroke-width: 1.2; }`,
  },
];

export const byKey = (k) => STYLES.find((s) => s.key === k);

// 모든 스타일이 공유하는 그림 규칙. SVG 안의 class 하나하나가 여기 한 줄과 짝이다.
export const DIAGRAM_CSS = `/* svg-diagram: SVG 안에는 좌표와 class 만, 색 · 선 · 글꼴은 전부 여기 */
.d { display: block; max-width: 100%; height: auto; font-family: var(--font-diagram); font-size: var(--fs); }
.d text { fill: var(--fg); }
.d .box, .d .lane { fill: var(--box); stroke: var(--stroke); stroke-width: var(--sw); }
.d .lane.alt { fill: var(--bg); }
.d .lead { fill: var(--accent-soft); stroke: var(--accent); stroke-width: var(--sw); }
.d .gate { fill: var(--blue-soft); stroke: var(--blue); stroke-width: var(--sw); }
.d .io { fill: var(--io-soft); stroke: var(--stroke); stroke-width: var(--sw); }
.d .ext { fill: var(--ext-soft); stroke: var(--muted); stroke-dasharray: 4 3; stroke-width: var(--sw); }
.d .exit { fill: var(--bg); stroke: var(--stroke); stroke-width: var(--sw); }
.d .bar { fill: var(--bar); } .d .bar.lead { fill: var(--accent); } .d .bar.gate { fill: var(--bar); }
.d .frame { fill: none; stroke: var(--fg); stroke-dasharray: 6 4; }
.d .tag { fill: var(--tag); }
.d .t-tag { font-family: var(--font-mono); font-size: var(--fs-tag); fill: var(--tag-fg); letter-spacing: .04em; }
.d .t-frame { font-family: var(--font-mono); font-size: var(--fs-tag); fill: var(--muted); letter-spacing: .04em; }
.d .t-title { font-size: var(--fs-title); font-weight: 700; }
.d .t-title.on-bar, .d .t-lane.on-bar { fill: var(--on-bar); }
.d .t-k { font-family: var(--font-mono); font-size: var(--fs-k); fill: var(--fg); opacity: .72; }
.d .t-v { font-size: var(--fs-v); }
.d .t-lane { font-size: var(--fs-title); font-weight: 700; fill: var(--fg); }
.d .t-label { font-size: var(--fs-label); fill: var(--fg); paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; }
.d .sep { stroke: var(--line); }
.d .life { stroke: var(--fg); stroke-width: 1; stroke-dasharray: 3 5; }
.d .edge { fill: none; stroke: var(--fg); stroke-width: var(--ew); stroke-linecap: var(--cap); stroke-linejoin: round; }
.d .edge.msg { stroke-width: calc(var(--ew) * 1.25); }
.d .edge.msg.ret { stroke-dasharray: 9 5; }
.d .edge.back { stroke: var(--blue); }
.d .edge.cond, .d .edge.ret { stroke-dasharray: 6 4; }
.d .edge.accent { stroke: var(--accent); }
.d .arr { fill: var(--fg); stroke: var(--fg); } .d .arr-b { fill: var(--blue); stroke: var(--blue); } .d .arr-a { fill: var(--accent); stroke: var(--accent); }
.d path.grid { stroke: var(--grid); fill: none; stroke-width: .7; }
.d circle.grid { fill: var(--grid); stroke: none; }
`;

const tokenCss = (t) =>
  Object.entries(t)
    .map(([k, v]) => `--${k}: ${v};`)
    .join(" ");
const fsCss = (g) =>
  `--fs: ${g.u}px; --fs-title: ${g.u * g.r.title}px; --fs-v: ${g.u * g.r.v}px; --fs-k: ${g.u * g.r.k}px; --fs-label: ${g.u * g.r.label}px; --fs-tag: ${g.u * g.r.tag}px;`;

// 스타일 하나의 CSS: 토큰(세 벌 — 기본 · prefers-color-scheme · data-theme 양쪽) + 그 스타일의 규칙.
// 셀렉터 .s-KEY 는 svg 자신(class="d s-KEY")에도, 미리보기 body 에도 붙는다.
function styleBlock(s) {
  const sel = `.s-${s.key}`;
  const base = `--font-diagram: ${s.fonts.diagram}; --font-mono: ${s.fonts.mono}; --sw: ${s.stroke.sw}; --ew: ${s.stroke.ew}; --cap: ${s.stroke.cap}; ${fsCss(s.geo)}`;
  const L = tokenCss(s.tokens.light),
    D = s.tokens.dark ? tokenCss(s.tokens.dark) : null;
  let out;
  if (!D)
    out = `${sel} { ${base} ${L}${s.single === "dark" ? " color-scheme: dark;" : ""} }`;
  else if (s.darkFirst)
    out = `${sel} { ${base} ${D} color-scheme: dark; }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) ${sel} { ${L} color-scheme: light; } }
:root[data-theme="light"] ${sel} { ${L} color-scheme: light; }`;
  else
    out = `${sel} { ${base} ${L} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) ${sel} { ${D} color-scheme: dark; } }
:root[data-theme="dark"] ${sel} { ${D} color-scheme: dark; }`;
  return `/* svg-diagram 스타일: ${s.key} — ${s.name} */\n${out}\n${s.rules.replace(/\.d /g, `.d${sel} `)}\n`;
}

// 페이지 <style> 에 한 번 넣는 CSS. keys: 그 페이지가 쓰는 스타일 key 들.
export const cssFor = (keys) =>
  DIAGRAM_CSS + keys.map((k) => styleBlock(byKey(k))).join("\n");

// 미리보기(--html)에서 doc 스타일이 참조하는 문서 토큰의 기본값(편집 지면 팔레트). 실제 문서에서는 그 문서의 값이 쓰인다
export const DOC_FALLBACK_CSS = `:root { --bg: #EEF0F1; --surface: #F9FAFA; --sunken: #E5E9EA; --ink: #14181B; --ink-2: #47535B; --ink-3: #6E7C85; --line: #D2D8DB; --line-soft: #E2E6E8; --accent: #A8451A; --accent-bg: rgba(168, 69, 26, 0.09); --blue: #3F6180; --blue-bg: rgba(63, 97, 128, 0.10); --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #0F1417; --surface: #161D21; --sunken: #12181B; --ink: #E4E9EB; --ink-2: #A3B0B7; --ink-3: #77858D; --line: #273138; --line-soft: #1E272C; --accent: #E38C55; --accent-bg: rgba(227, 140, 85, 0.13); --blue: #83A9C6; --blue-bg: rgba(131, 169, 198, 0.13); color-scheme: dark; } }
:root[data-theme="dark"] { --bg: #0F1417; --surface: #161D21; --sunken: #12181B; --ink: #E4E9EB; --ink-2: #A3B0B7; --ink-3: #77858D; --line: #273138; --line-soft: #1E272C; --accent: #E38C55; --accent-bg: rgba(227, 140, 85, 0.13); --blue: #83A9C6; --blue-bg: rgba(131, 169, 198, 0.13); color-scheme: dark; }
.s-doc { --fg: var(--ink); --muted: var(--ink-3); }`;
