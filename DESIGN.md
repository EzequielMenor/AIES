---
name: AIES Design System
description: Minimalist editorial engineering design system for AIES Autonomous Harness & Runtime
colors:
  primary: "#10b981"
  neutral-bg-dark: "#090a0d"
  neutral-bg-light: "#fafaf9"
  surface-dark: "#101217"
  surface-light: "#ffffff"
  border-dark: "#232730"
  border-light: "#e6e6e4"
  text-dark: "#f0f2f5"
  text-light: "#171717"
  text-muted-dark: "#8b92a0"
  text-muted-light: "#737370"
typography:
  display:
    fontFamily: "Newsreader, Georgia, serif"
    fontSize: "clamp(2.25rem, 5vw, 3.75rem)"
    fontWeight: 400
    lineHeight: 1.12
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Newsreader, Georgia, serif"
    fontSize: "clamp(1.5rem, 3vw, 2.25rem)"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  mono:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.05em"
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 300
    lineHeight: 1.6
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface-dark}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-secondary:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.text-dark}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
---

# Design System: AIES

## Overview

**Creative North Star: "The Minimalist Engineering Monograph"**

A sober, authoritative, high-contrast editorial system designed for systems engineers, AI developers, and technical architects. Inspired by clean Swiss typography and developer monographs (Newsreader serif + JetBrains Mono), the interface balances technical density with open whitespace and hairline structural dividers.

**Key Characteristics:**
- High-contrast typography pairing literary serif headlines with precise monospace metadata and telemetry.
- Strict dark/light color fidelity driven by CSS custom variables.
- Hairline structural rules and numbered sections (`01`, `02`, `03`) establishing disciplined hierarchy.
- Live interactive stream simulators demonstrating deterministic task execution and context isolation.

## Colors

The palette is rooted in deep obsidian slate (dark mode) and crisp architectural paper (light mode), energized by an emerald verification pulse.

### Primary
- **Emerald Verification** (#10b981): Highlights objective PASS states, active operational telemetry, and successful execution verdicts.

### Neutral
- **Obsidian Ground** (#090a0d): The normative dark mode canvas.
- **Paper Ground** (#fafaf9): The normative light mode canvas.
- **Surface Elevation** (#101217 / #ffffff): Card containers and interactive panel surfaces.
- **Hairline Border** (#232730 / #e6e6e4): Precise boundary lines separating sections and tables.
- **Chalk Text** (#f0f2f5 / #171717): High-contrast primary reading text.
- **Slate Muted** (#8b92a0 / #737370): Monospaced labels, breadcrumbs, and secondary explanatory copy.

### Named Rules
**The Verification Accent Rule.** Emerald is reserved exclusively for verified states, active operational indicators, and metrics. It is never used for decorative backgrounds or arbitrary buttons.

## Typography

**Display Font:** Newsreader (serif, weights 400/500/600)
**Body Font:** System Sans-Serif (system-ui, -apple-system, Segoe UI)
**Label/Mono Font:** JetBrains Mono (monospace, weights 400/500)

**Character:** High-craft editorial authority meets terminal engineering precision.

### Hierarchy
- **Display** (400, clamp(2.25rem, 5vw, 3.75rem), 1.12): Hero statements and high-level thesis.
- **Headline** (400, clamp(1.5rem, 3vw, 2.25rem), 1.2): Section titles (`01. El Problema`, `02. Arquitectura`).
- **Title** (400, 1.25rem, 1.3): Feature and card titles.
- **Body** (300, 0.875rem–1rem, 1.6): Explanatory paragraphs with max-w-2xl width.
- **Label** (400, 0.75rem, uppercase tracking-widest): Monospace section markers, timestamps, versions, tags, and telemetry data.

## Layout

The page adheres to a centered single-column grid (`max-w-4xl`) with consistent horizontal padding (`px-6`) and generous section pacing (`py-16` / `space-y-16`). Sections are separated by hairline borders.

## Elevation & Depth

Surfaces are predominantly flat and structural, relying on subtle color differentiation (`--color-surface` vs `--color-surface-2`) and hairline borders rather than heavy blur shadows.

### Named Rules
**The Flat-By-Default Rule.** All containers are flat at rest. Depth is indicated by border contrast shifts on hover (`--color-border-hover`) rather than dramatic drop shadows.

## Shapes

Corners use restrained, consistent radii:
- Small tags and pills: 6px (`rounded-md`)
- Interactive buttons and input pills: 8px (`rounded-lg`)
- Cards and terminal enclosures: 12px (`rounded-xl`)

## Components

### Buttons & Pills
- **Install Pill:** Monospaced code box with copy-to-clipboard action and toast indicator.
- **Navigation Links:** Monospaced subtle text links with hover underline or color shift.

### Terminal Simulator
- **Enclosure:** Dark surface container with mock traffic lights, mode tabs, structured turn logs, and real-time token comparison metrics.

## Do's and Don'ts

### Do:
- **Do** maintain strict separation between Newsreader serif headlines and JetBrains Mono metadata.
- **Do** preserve the maximum width constraint (`max-w-4xl`) for readable editorial pacing.
- **Do** keep animations subtle (fade-in and 14px translateY on scroll).

### Don'ts:
- **Don't** add glowing neon gradients or generic AI sparkles.
- **Don't** use saturated accent colors for decorative section backgrounds.
