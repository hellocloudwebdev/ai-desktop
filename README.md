<div align="center">

# AI Desktop

**Next-Generation Local-First AI Workspace & Multi-Provider Desktop Assistant**

[![Platform](<https://img.shields.io/badge/Platform-Windows%2010%20%2F%2011%20(x64)-0078D6?logo=windows>)](README.md#-platform-support)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen?logo=node.js)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-11.25.0-orange?logo=pnpm)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Vitest](https://img.shields.io/badge/Vitest-4.1.11-yellow?logo=vitest)](https://vitest.dev/)
[![Electron](https://img.shields.io/badge/Electron-44.0.0-47848F?logo=electron)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19.2.8-61DAFB?logo=react)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-4.3.3-38B2AC?logo=tailwind-css)](https://tailwindcss.com/)
[![Security](https://img.shields.io/badge/Security-Fail--Closed-red)](docs/architecture/CONSTITUTION.md)

<p align="center">
  <a href="#-platform-support">Platform Support</a> •
  <a href="#-download--installation-windows">Download & Install</a> •
  <a href="#-features">Features</a> •
  <a href="#-architecture">Architecture</a> •
  <a href="#-verification--quality-gates">Quality Gates</a> •
  <a href="#-toolchain">Toolchain</a>
</p>

</div>

---

## 📖 Overview

**AI Desktop** is an extensible desktop assistant built on Electron 44 and React 19. Designed from first principles for **privacy, performance, and deterministic security**, AI Desktop orchestrates state-of-the-art language models, sandboxed coding environments, browser automation, and local tool ecosystems through a strictly audited, unidirectional architecture.

All user data, conversation histories, schedules, and memory facts remain local-first in an encrypted/OS-keychain-backed SQLite database with zero cloud telemetry.

---

## ✨ Features

| Capability                           | Highlights                                                                                                                                                                                                               |
| :----------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🧠 **Multi-Provider Intelligence**   | Seamless per-conversation model switching between Anthropic Claude (3.7 / 3.5 Sonnet) and Google Gemini (2.5 Pro / Flash). Provider-neutral streaming chat engine with active stream registry and sub-32ms IPC batching. |
| 🛡️ **5-Dimension Permission Engine** | Real-time policy evaluation across 4 approval scopes. Deterministic audit trails stored in SQLite; zero automatic escalation.                                                                                            |
| 💻 **Sandboxed Coding Agent**        | Autonomous coding workspace with workspace-aware path security, symlink-escape rejection, bounded terminal execution, and built-in Git diff & review surface.                                                            |
| 🔌 **Model Context Protocol (MCP)**  | First-class MCP Host supporting tool discovery, resource templates, dynamic prompts, and interactive MCP Apps via sandboxed Rich Surfaces.                                                                               |
| 🌐 **Browser & Web Research**        | Controlled Puppeteer browser automation, SSRF-guarded HTTP fetch, multi-channel source canonicalization, and numeric claim conflict detection.                                                                           |
| 📚 **Project Document RAG**          | Native parsing for Markdown, PDF, CSV, JSON, and plaintext with deterministic chunking, lexical scoring, and project-isolated retrieval.                                                                                 |
| ⏱️ **Autonomous Tasks & Scheduling** | Resilient background agent execution and multi-schedule automation (delay, interval, daily, weekly) with idempotent crash recovery.                                                                                      |
| 🔄 **Cross-Device Sync**             | Conflict-free delta synchronization using deterministic tombstone envelopes and OS Keychain secret storage.                                                                                                              |
| 📦 **Production Auto-Updater**       | Cryptographically verified updates over HTTPS with SHA-256 sidecars, host allowlists, and non-destructive data retention.                                                                                                |

---

## 💻 Platform Support

| Platform            | Compatibility     | Architecture    | Release Status                                                                                        |
| :------------------ | :---------------- | :-------------- | :---------------------------------------------------------------------------------------------------- |
| **Windows 10 / 11** | ✅ Supported      | `x64` (64-bit)  | [v0.0.0 NSIS Installer Available](https://github.com/hellocloudwebdev/ai-desktop/releases/tag/v0.0.0) |
| **macOS**           | 🚧 In Development | `arm64` / `x64` | Canonical domain contracts ready; desktop packaging pending                                           |
| **Linux**           | 🚧 In Development | `x64`           | Domain contracts ready; desktop packaging pending                                                     |

---

## 📥 Download & Installation (Windows)

### 🖥️ Option 1: Install via Pre-Built Windows Installer (Recommended)

Download the official standalone Windows setup package from [GitHub Releases](https://github.com/hellocloudwebdev/ai-desktop/releases/tag/v0.0.0):

- **Direct Installer Download**: **[`AI Desktop-0.0.0-win-x64-setup.exe`](https://github.com/hellocloudwebdev/ai-desktop/releases/download/v0.0.0/AI.Desktop-0.0.0-win-x64-setup.exe)** (~125 MB)
- **SHA-256 Checksum**: `6e756b61faae6a506ba92bbd964a6c4a3be627db98fac6ae2c79832c5cd52cb2`
- **Release Page**: [AI Desktop v0.0.0 Releases](https://github.com/hellocloudwebdev/ai-desktop/releases/tag/v0.0.0)

#### Installation Steps:

1. Download **`AI Desktop-0.0.0-win-x64-setup.exe`**.
2. Double-click the installer to launch the setup wizard.
3. Select your installation folder (per-user installation; no administrative rights required).
4. Launch **AI Desktop** from the Start Menu or Desktop shortcut.

> **Data Safety Guarantee:** Installing, upgrading, or uninstalling AI Desktop on Windows will **never** overwrite or delete your databases, conversations, or credentials. All local state persists safely in `%APPDATA%\aidesktop` (`deleteAppDataOnUninstall: false`).

---

### 🛠️ Option 2: Build & Run from Source (Windows)

If you are developing or contributing to AI Desktop, follow these steps to run the application from source.

#### Prerequisites

Ensure you have the following installed on your Windows system:

1. **Node.js**: `>= 22.0.0` (Download LTS from [nodejs.org](https://nodejs.org/))
2. **pnpm**: `11.25.0`
   ```powershell
   npm install -g pnpm@11.25.0
   ```
3. **Git for Windows**: Available from [git-scm.com](https://git-scm.com/)

---

#### Step-by-Step Setup

##### 1. Clone the repository

Open PowerShell or Windows Terminal and clone the codebase:

```powershell
git clone https://github.com/hellocloudwebdev/ai-desktop.git
cd ai-desktop
```

##### 2. Install workspace dependencies

Install all locked packages and set up workspace links across the monorepo:

```powershell
pnpm install
```

##### 3. Run validation gates

Confirm that the toolchain, Prisma schema, and architectural boundaries pass validation:

```powershell
pnpm architecture:check
pnpm typecheck
```

##### 4. Launch the application (Development Mode)

Start the Vite development servers and launch the Electron desktop shell with Hot Module Replacement (HMR):

```powershell
pnpm dev
```

The AI Desktop window will open automatically, connected to local development watchers.

##### 5. Build your own Windows installer

You can also package your own local Windows NSIS installer at any time:

```powershell
pnpm --filter @ai-desktop/desktop dist:win
```

Outputs the setup binary to `apps/desktop/release/AI Desktop-0.0.0-win-x64-setup.exe`.

---

## 🏗️ Architecture

AI Desktop is structured as a **Turborepo monorepo** with 13 strictly scoped packages. Dependencies strictly follow the unidirectional architecture outlined in [CONSTITUTION.md](docs/architecture/CONSTITUTION.md).

```
                      ┌─────────────────────────┐
                      │   apps/desktop (Shell)   │
                      └────────────┬────────────┘
                                   │
       ┌───────────────────────────┼───────────────────────────┐
       ▼                           ▼                           ▼
┌──────────────┐          ┌─────────────────┐         ┌─────────────────┐
│ @ai-desktop/ │          │   @ai-desktop/  │         │   @ai-desktop/  │
│   desktop    │          │  agent-runtime  │         │    ai-core      │
└──────┬───────┘          └────────┬────────┘         └────────┬────────┘
       │                           │                           │
       ▼                           ▼                           ▼
┌──────────────┐          ┌─────────────────┐         ┌─────────────────┐
│ @ai-desktop/ │          │   @ai-desktop/  │         │   @ai-desktop/  │
│  providers   │          │     storage     │         │   permissions   │
└──────────────┘          └─────────────────┘         └─────────────────┘
```

### Package Manifest

| Package                                               | Role & Boundaries                                                                              |
| :---------------------------------------------------- | :--------------------------------------------------------------------------------------------- |
| [`@ai-desktop/shared`](packages/shared)               | Primitive types, branded identifiers, and shared invariant utilities.                          |
| [`@ai-desktop/ai-core`](packages/ai-core)             | Core domain entities: messages, streaming events, tools, projections, and canonical protocols. |
| [`@ai-desktop/providers`](packages/providers)         | LLM adapters (Anthropic Claude SDK & Google Gemini SDK), model profiles, and capabilities.     |
| [`@ai-desktop/storage`](packages/storage)             | Local SQLite persistence via Prisma with WAL mode and OS Keyring integration.                  |
| [`@ai-desktop/permissions`](packages/permissions)     | 5-dimension deterministic policy engine and approval audit ledger.                             |
| [`@ai-desktop/mcp`](packages/mcp)                     | Model Context Protocol client, MCP server discovery, and tool execution isolation.             |
| [`@ai-desktop/skills`](packages/skills)               | Skill package validator, SHA-256 manifest verification, and execution lifecycle.               |
| [`@ai-desktop/execution`](packages/execution)         | Isolated process sandboxing, Docker/container runner, and command execution limits.            |
| [`@ai-desktop/memory`](packages/memory)               | Scoped memory facts, contradiction resolution (`superseded_by`), and extraction.               |
| [`@ai-desktop/agent-runtime`](packages/agent-runtime) | In-process asynchronous EventBus, Kahn DAG TaskGraph validation, and ReAct loops.              |
| [`@ai-desktop/plugins`](packages/plugins)             | Extension registry, capability declarations, and third-party plugin boundaries.                |
| [`@ai-desktop/workspace`](packages/workspace)         | Desktop workspace contracts and state primitives.                                              |
| [`@ai-desktop/desktop`](apps/desktop)                 | Electron application shell, typed IPC boundary, and React 19 UI renderer.                      |

---

## 🔒 Verification & Quality Gates

The codebase enforces strict, automated verification gates. Every pull request and release build must pass all seven validation stages:

```bash
# 1. Type verification across all 13 workspace projects
pnpm typecheck

# 2. ESLint checks with AST-level boundary enforcement
pnpm lint

# 3. Dependency graph integrity & import verification
pnpm architecture:check

# 4. Full test suite execution (Vitest 4.1.11)
pnpm test

# 5. Production build of packages and desktop shell
pnpm build

# 6. Prettier formatting conformance
pnpm format:check

# 7. Security boundary and secret-exposure checks
pnpm security:check
```

---

## 🧰 Toolchain

| Tool             | Pinned Version | Purpose / Scope                                                    |
| :--------------- | :------------- | :----------------------------------------------------------------- |
| **Node.js**      | `>= 22`        | Modern ECMAScript runtime                                          |
| **pnpm**         | `11.25.0`      | Monorepo package manager & workspace linker                        |
| **Turborepo**    | `2.10.12`      | Build and test task orchestration                                  |
| **TypeScript**   | `5.9.3`        | Type system across all packages (`noUncheckedIndexedAccess`)       |
| **Vitest**       | `4.1.11`       | Root and package test runner                                       |
| **Vite**         | `8.1.0`        | High-speed frontend & electron bundler                             |
| **Electron**     | `44.0.0`       | Desktop application shell (`apps/desktop` only)                    |
| **React**        | `19.2.8`       | Renderer UI framework (`apps/desktop` only)                        |
| **Tailwind CSS** | `4.3.3`        | Utility styling via `@tailwindcss/vite`                            |
| **Prisma**       | `6.4.1`        | SQLite database ORM (`packages/storage` only)                      |
| **Prettier**     | `3.9.6`        | Code formatting                                                    |
| **ESLint**       | `^10.10.0`     | Linting with `typescript-eslint` 8.69 & `eslint-plugin-boundaries` |

---

## 🔐 Security & Privacy Invariants

- **Zero Plaintext Secrets:** API keys and credentials are saved directly into your operating system's native keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service).
- **Normative Constitution:** Strictly enforced by automated AST checks. No Electron imports outside `apps/desktop`; no Prisma imports outside `packages/storage`.
- **Fail-Closed Permissions:** File system edits, command execution, and network access require explicit, granular user consent.
- **Audited Tool Sandboxing:** All local command execution runs inside memory-, CPU-, and path-constrained environments.

---

## 📄 License

This repository and its source code are private and proprietary. All rights reserved.
