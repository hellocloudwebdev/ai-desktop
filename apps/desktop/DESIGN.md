---
version: alpha
name: AI Desktop Design System
colors:
  primary: "#090D16"
  secondary: "#64748B"
  accent: "#6366F1"
  accent-glow: "#818CF8"
  paper: "#0B0F19"
  ink: "#F8FAFC"
  ink-muted: "#94A3B8"
  ink-faint: "#475569"
  surface: "#111726"
  surface-elevated: "#161F33"
  surface-glass: "rgba(17, 23, 38, 0.75)"
  border: "#1E293B"
  border-subtle: "#1E293B99"
  border-active: "#6366F1"
  error: "#F43F5E"
  warning: "#F59E0B"
  success: "#10B981"
  info: "#06B6D4"
typography:
  h1:
    fontFamily: Plus Jakarta Sans, Inter, system-ui, sans-serif
    fontSize: 1.25rem
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: -0.02em
  body:
    fontFamily: Inter, system-ui, -apple-system, sans-serif
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.5
  mono:
    fontFamily: JetBrains Mono, ui-monospace, SFMono-Regular, monospace
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#FFFFFF"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  card-surface:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border}"
    rounded: "{rounded.lg}"
    padding: "16px"
---

# AI Desktop Design System

## 1. Overview

The visual identity of **AI Desktop** is defined as _"Neo-Precision Dark Glass"_ — combining the disciplined precision of modern high-performance developer tools (Linear, Raycast, Vercel Geist) with subtle glassmorphic depth. It is purpose-built for extended engineering and AI-assisted workflows: high contrast, zero ocular fatigue, clear spatial hierarchy, and immediate tactile feedback.

### The Three Design Dials

- **Variance (5/10)**: Modern, balanced, clean desktop layout with disciplined alignment and zero visual clutter.
- **Motion (4/10)**: Snappy 120–180ms ease-out transitions (`cubic-bezier(0.16, 1, 0.3, 1)`), strictly collapsing to 0ms when `prefers-reduced-motion` is active.
- **Density (7/10)**: High-efficiency information density tailored for desktop monitors with an 8px rhythmic spacing scale.

---

## 2. Colors & Paper/Ink/Accent Roles

- **Paper (`#0B0F19`)**: The base obsidian canvas, providing deep contrast without the harshness of pure `#000000`.
- **Surfaces (`#111726` / `#161F33`)**: Layered architectural elevations with translucent blur (`backdrop-blur-md`) separating navigation, active work, and context inspectors.
- **Ink (`#F8FAFC`)**: High-legibility crisp text meeting WCAG AAA 7:1 contrast against dark paper.
- **Accent (`#6366F1` Electric Indigo & `#06B6D4` Cyan)**: Primary drivers for active navigation pills, streaming indicators, and commit actions.

---

## 3. Typography

- **Primary Interface Font**: Inter / Plus Jakarta Sans (`system-ui`, `-apple-system`, `sans-serif`) for crisp UI controls and readable paragraphs.
- **Code & Monospace Font**: JetBrains Mono / SFMono for code tabs, diff hunks, hashes, and line number gutters.
- **Micro-Labels**: Clean `text-[11px]` and `text-xs` with `font-medium` replacing unreadable 9px text.

---

## 4. Elevation & Depth

- Hairline borders (`border border-slate-800/80` or `1px solid rgba(255, 255, 255, 0.08)`) define every panel and card.
- Subtle inner glows on hover (`hover:border-slate-700 hover:bg-slate-800/60`).
- Scrims and floating modals use `bg-black/60 backdrop-blur-sm`.

---

## 5. Components & State Invariants

Every interactive component explicitly supports:

- **Default State**: Defined borders, clear labels, distinct contrast.
- **Hover State**: Subtle brightness increase, border glow, cursor change.
- **Active / Pressed**: Immediate micro-scale feedback (`active:scale-[0.98]`).
- **Focus State**: Uncompromising accessibility ring (`focus-visible:ring-2 focus-visible:ring-indigo-500`).
- **Disabled State**: Clear `opacity-50 cursor-not-allowed`.
- **Streaming State**: Glowing pulsing status dot with color-coded alerts.
