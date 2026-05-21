# Design system

## Design intent

Dark, technical, editorial. A single cyan accent doing all the highlighting work. Serif display type for headlines (with italic for emphasis), sans for body, mono for UI chrome and metadata. Cards with hairline borders. No drop shadows except a subtle cyan glow on the verdict card. The aesthetic is "instrument panel for watching language models reason against each other" — quiet, confident, restrained.

Visual reference: `/research/prototype.html` is the canonical mock for spacing, hierarchy, and visual rhythm. Treat divergence from it as a bug.

## Color tokens

All colors live in CSS variables defined on `:root` in `/client/src/index.css`. Tailwind extends from these.

| Variable | Hex | Use |
|---|---|---|
| `--bg` | `#0a0a0a` | Page background |
| `--surface` | `#111111` | Cards, raised surfaces |
| `--surface-2` | `#161616` | Hover states, table headers, secondary surfaces |
| `--border` | `#1f1f1f` | Default card and divider borders |
| `--border-bright` | `#2a2a2a` | Card hover borders, input borders |
| `--accent` | `#22d3ee` | The single accent color (cyan-400) |
| `--accent-dim` | `#0e7490` | Darker cyan for scrollbar thumb, pressed states |
| `--text` | `#f5f5f5` | Primary text |
| `--text-muted` | `#a3a3a3` | Body prose, subhead text |
| `--text-dim` | `#525252` | Metadata, labels, dim accents |

**Usage rule:** the accent color is for emphasis only. Never use it for body text, never use it on more than ~10% of pixels on any screen. The eye should find it.

## Typography

Three font families, loaded via Google Fonts in `/client/src/index.css`:

| Family | Weights | Use |
|---|---|---|
| **Crimson Pro** | 400, 500, 600, 700, 400 italic | Display headings, hero text, verdict text. Use italic for cyan-accented emphasis lines (e.g. "until one of them wins"). |
| **Inter** | 300, 400, 500, 600, 700 | Body prose, button text, form labels |
| **JetBrains Mono** | 400, 500, 600, 700 | All UI chrome: nav links, metadata, IDs, timestamps, ELO numbers, section labels, tool call badges, status indicators |

Tailwind utility classes:
- `font-serif` → Crimson Pro
- (default) → Inter
- `font-mono` → JetBrains Mono

## Type scale

| Use | Size | Family | Weight |
|---|---|---|---|
| Hero headline | 60px / leading-[1.05] | serif | 500 |
| Page h1 | 36px / leading-tight | serif | 500 |
| Section h2 | 24px / leading-snug | serif | 500 |
| Card title | 18px | sans | 500 |
| Body | 14–16px / leading-relaxed | sans | 400 |
| UI label | 11–12px / tracking-wider, uppercase | mono | 500 |
| Metadata | 11–12px | mono | 400 |

## Component patterns

### Card
```jsx
<div className="card rounded">...</div>
// or with hover:
<div className="card card-hover rounded">...</div>
```
CSS:
```css
.card { background: var(--surface); border: 1px solid var(--border); transition: border-color 0.2s; }
.card-hover:hover { border-color: var(--border-bright); }
```

### Button — primary
```jsx
<button className="btn-primary px-6 py-3 rounded font-mono text-sm">stage debate ▸</button>
```
CSS:
```css
.btn-primary { background: var(--accent); color: var(--bg); font-weight: 600; transition: all 0.2s; }
.btn-primary:hover { box-shadow: 0 0 24px rgba(34, 211, 238, 0.4); transform: translateY(-1px); }
```

### Button — secondary
```jsx
<button className="btn-secondary px-6 py-3 rounded font-mono text-sm">browse</button>
```
CSS:
```css
.btn-secondary { border: 1px solid var(--border-bright); color: var(--text); transition: all 0.2s; }
.btn-secondary:hover { border-color: var(--accent); color: var(--accent); }
```

### Pulse dot — for live/streaming indicators
```jsx
<span className="pulse-dot"></span>
```
CSS:
```css
.pulse-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px var(--accent); animation: pulse 1.5s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
```

### Tool call badge — appears inline on debate turn cards
```jsx
<span className="tool-call-badge font-mono text-xs px-2 py-1 rounded">web_search · query text</span>
```
CSS:
```css
.tool-call-badge { background: rgba(34, 211, 238, 0.06); border: 1px solid rgba(34, 211, 238, 0.18); color: var(--accent); }
```

### Score bar — for judge evaluation
4 bars per side. Label + numeric value + thin horizontal bar filled cyan.
```jsx
<div>
  <div className="flex justify-between text-xs mb-1">
    <span className="text-muted">Argument</span>
    <span className="font-mono">8.5</span>
  </div>
  <div className="h-1 bg-surface-2 rounded overflow-hidden">
    <div className="h-full" style={{width: '85%', background: 'var(--accent)', opacity: 0.65}}></div>
  </div>
</div>
```

### Accent glow — applied to verdict card only
```css
.accent-glow { box-shadow: 0 0 32px rgba(34, 211, 238, 0.12); }
```

### Input fields
```css
input, textarea, select {
  background: var(--surface);
  border: 1px solid var(--border-bright);
  color: var(--text);
  font-family: inherit;
}
input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
```

### Navigation links (header)
Mono, lowercase, muted by default. Active route gets accent color and a 1px accent underline 18px below.
```css
.nav-link { color: var(--text-muted); transition: color 0.15s; position: relative; }
.nav-link:hover { color: var(--accent); }
.nav-link.active { color: var(--accent); }
.nav-link.active::after { content: ''; position: absolute; bottom: -18px; left: 0; right: 0; height: 1px; background: var(--accent); }
```

## Animation tokens

- **fade-in on mount:** 0.3s ease-out, translateY(4px) → 0
- **typewriter cursor:** `▊` character, accent color, blink animation 1s steps(2, jump-none) infinite
- **pulse dot:** see above
- **hover state transitions:** 0.15–0.2s ease (border-color, color, transform)
- **button hover translate:** -1px
- **button hover glow:** 0 0 24px rgba(34, 211, 238, 0.4)

## Layout conventions

- Max width: `max-w-7xl` (1280px) for main page content, centered horizontally with `mx-auto`.
- Horizontal page padding: `px-6` (24px) on desktop.
- Vertical section spacing: `mb-20` (80px) between major page sections.
- Vertical card list spacing: `space-y-2` to `space-y-3` for compact lists, `space-y-6` for prose-heavy content (debate turns).
- Header is sticky, `bg-black/85 backdrop-blur-md`, `z-40`, `border-b border-divider`.

## Reference prototype

Before implementing any frontend page, open `/research/prototype.html` in a browser. The prototype is the source of truth for:
- Hero text and accent placement
- Card hover behavior and spacing
- The streaming typewriter effect on the live debate viewer
- The verdict card layout with two-column score grid
- The reveal animation when identities are unhidden after the judge verdict
- Footer content and treatment

The prototype is built with vanilla JS + Tailwind via CDN. The production React build should be visually indistinguishable, not "improved upon."
