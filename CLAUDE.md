# 🤖 Claude Instructions: Universal Monorepo Architecture

You are an expert full-stack engineer operating within a high-scale **Nx Monorepo**. You must strictly adhere to the architectural hierarchy, platform isolation, and testing protocols defined below.

## 🏗️ 1. Architectural Hierarchy & Dependency Flow

Dependencies flow **strictly downward**. Higher layers orchestrate; lower layers provide primitives. Never allow upward or circular dependencies.

| Layer             | Tag                   | Directory                 | Purpose                                            |
| :---------------- | :-------------------- | :------------------------ | :------------------------------------------------- |
| **Entrypoints**   | `layer:entrypoints`   | `apps/`                   | CLI Tools (Node) or Apps (Browser).                |
| **Workflows**     | `layer:workflows`     | `packages/features/`      | Stateful user journeys & sub-routing.              |
| **Components**    | `layer:components`    | `packages/features/`      | **Merge Point.** UI meets Data (GQL/DB).           |
| **UI-Composites** | `layer:ui-composites` | `packages/design-system/` | Complex **Pure Visual** units (Cards).             |
| **UI-Primitives** | `layer:ui-primitives` | `packages/design-system/` | Atomic visual units (Buttons, Hooks).              |
| **Data**          | `layer:data`          | `packages/shared/`        | Data Engines (e.g., `query` package).              |
| **Logic**         | `layer:logic`         | `packages/shared/`        | Domain-specific Business Rules.                    |
| **Shared**        | `layer:shared`        | `packages/shared/`        | **Foundation Tools** (e.g., `data`, `transform`).  |

## 🛑 2. Platform Isolation (Environment Rules)

We use a "Two-Way Mirror" to prevent environment crashes and security leaks:

- **`platform:node`**: Used for **CLI tools** (e.g., `decompile`).
  - _Constraint:_ **NEVER** import Browser code (`react-hooks`, `window`, `document`, CSS).
- **`platform:browser`**: Used for **UI** (React Apps, Storybook).
  - _Constraint:_ **NEVER** import Node internals (`fs`, `path`, server-side resolvers).
- **`platform:shared`**: Used for **Universal Tools** (e.g., `query`, `data`, `transform`).
  - _Constraint:_ Must be **Pure TypeScript**. It must be safe to run in both a Node CLI and a Browser window.

## 🛠️ 3. Existing Package Context

Refer to these established packages when building new features:

- **`decompile`** (`packages/decompile`): A Node CLI entrypoint. **Platform: node.**
- **`query`** (`packages/query`): In-browser/Node DB engine. **Platform: shared.**
- **`data`** (`packages/data`): Generic data analysis utilities. **Platform: shared.**
- **`transform`** (`packages/transform`): Basic type transforms (camelCase, deepCopy). **Platform: shared.**
- **`react-hooks`** (`packages/react-hooks`): UI-only logic. **Platform: browser.**
- **`storybook`** (`packages/storybook`): UI testing config. **Platform: browser.**

## 🚀 4. Scaffolding Cheat Sheet

When generating new modules, use the syntax:
`./generate-lib.sh <app|lib> <name> <layer> <platform>`

- **New Logic/Util:** `./generate-lib.sh lib my-tool logic shared`
- **New UI Component:** `./generate-lib.sh lib user-card ui-composites browser`
- **New CLI Entrypoint:** `./generate-lib.sh app my-cli entrypoints node`
- **New React Entrypoint:** `./generate-lib.sh app web-dashboard entrypoints browser`

_Always verify the `project.json` after generation to ensure tags were applied correctly._

## 💻 5. Development & Nx Commands

- **List Projects:** `npx nx list`
- **Build Project:** `npx nx build <project-name>`
- **Run Tests:** `npx nx test <project-name>`
- **Linting:** `npx nx lint <project-name>`
- **Graph Visualization:** `npx nx graph` (Use this to verify dependency flow).

## 🧪 6. Testing Protocol

- **Logic/Math:** Use `layer:test-logic` (Vitest/Node). Focus on edge cases and pure functions.
- **UI/Hooks:** Use `layer:test-ui` (JSDOM/Storybook). Focus on component states and user interactions.
- **Verification:** Before marking a task as complete, you must run the relevant test suite and ensure 0 failures.

## 🔄 8. Refactoring & Purity Protocol (CRITICAL)

You are responsible for maintaining the health of the shared ecosystem. **Follow these rules for every code change:**

1.  **Prefer Imports over Creation:** Before writing a utility (e.g., deep copy, camelCase, data filter), check `@adhd/data`, `@adhd/transform`, and `@adhd/query`. **Always** use existing exports.
2.  **The "Two-Use" Refactor Rule:** If you are writing logic in an `app` or `feature` that is generic and likely reusable, **STOP**.
    - Extract the logic.
    - Place it in the appropriate `packages/` shared package (e.g., `transform`).
    - Import it back into the original file using the `@adhd/` scoped path.
3.  **Dependency Purity:** Shared packages (`data`, `transform`) must **never** depend on high-level logic or UI. They are the bedrock.
4.  **Hyphenated NPM Naming:** All new libraries must use hyphenated names (e.g., `network-helpers`, not `networkHelpers`) for NPM compatibility.

## 📝 7. Code Style & Standards

- **Naming:** Use PascalCase for Components, camelCase for functions/variables.
- **Interfaces:** Prefix all Shared/Data interfaces with `I` (e.g., `IUserRecord`).
- **Imports:** Always use Nx workspace paths (e.g., `@adhd/transform`) instead of relative paths (`../../`).
- **Docs:** New public functions in `packages/shared` must include JSDoc comments.

## 📁 Workspace Context

- **Ignore:** Always ignore `dist/`, `.nx/`, and `tmp/` folders.
- **Entry:** Start by reading `project.json` in the target library to confirm tags.

## 💾 Commit Convention

- Use **Conventional Commits**: `feat(scope):`, `fix(scope):`, `refactor(scope):`.
- Always include the library name as the scope (e.g., `feat(ui-primitives): add segmented-control`).
