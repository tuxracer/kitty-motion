# kitty-motion

## Commands

- `pnpm check` - typecheck + lint + run all tests (run before committing)
- `pnpm test` - vitest in watch mode (`pnpm test:run` for a single pass)
- `pnpm lint` / `pnpm lint:fix` - ESLint over `src/`
- `pnpm build` - typecheck then tsup. The build has two entries: `index` and `encode-worker` (the PNG encode worker must ship as its own bundle so it can be loaded in a worker thread)
- `node examples/bouncing-ball.ts` - run the demo (requires Node >= 24; a Kitty-graphics-capable terminal gets full-quality graphics, other terminals fall back to block glyphs); `examples/plasma.ts` is a full-frame-change stress demo; `examples/green-hill.ts` is a parallax side-scroller workload. Demos share `examples/demoHarness/` (capability detection, debug log, interactive status bar, exit metrics summary); new demos supply a name, screen options, and a `renderFrame` callback. While a demo runs, `m` cycles render modes (kitty, cell truecolor, cell 256, cell 16), `g` toggles the cell glyph strategy (half blocks vs background-colored spaces), `e` cycles effect presets, `p` toggles pause, `q` or Ctrl-C exits
- Demo env overrides force capability paths for testing: `DEMO_RENDER_MODE=kitty|cell|half-block|cell-background` (force the graphics protocol or the block-glyph fallback; `cell` is an alias for the default `half-block`), `DEMO_DIRTY_RECTS=0|1`, `DEMO_FILE_TRANSFER=0|1`, `DEMO_LIMIT_COLORS=0|16|256` (pin cell-mode color depth; 0 means truecolor), `DEMO_CELL_GLYPH=half-block|cell-background` (pin the cell render mode), `DEMO_CELL_SAMPLING=box|nearest` (pin the cell downsampling strategy). Unset means probe-detected behavior. Env overrides set the initial state; the status bar shortcuts can change render mode and effects afterward at runtime

## Architecture

Data flow: `Screen` (public API, constructed via the async `createScreen()`, which runs the capability probes before the synchronous constructor reads their cached results) drives `KittyRenderer` (scaling, color, CRT post-processing), which hands frames to `kittyEncodeWorkerClient` and then `kittyEncodeWorker` (PNG encode on a worker thread; the second build entry, `dist/encode-worker.js`). Encoded output goes through `OutputGate` (backpressure-aware stdout writes; frames drop instead of queueing).

On terminals without Kitty graphics support (probed by
`detectKittyGraphicsSupport()`), `Screen` instead drives `CellRenderer`,
which renders frames as colored Unicode block glyphs with cell-level diffing
and no worker thread. On macOS Terminal.app (probed by `detectCellRenderMode()` and `detectCellSampling()` from `TERM_PROGRAM`), cells render as background-colored spaces at 1 pixel per cell with nearest sampling instead of box-averaged half blocks, because Terminal.app draws block glyphs from the font and no font tiles the cell exactly.

After the initial frames, `KittyRenderer` sends only the changed bounding
rectangle as an animation-protocol frame edit (`a=f`) when the terminal
supports it (probed by `detectKittyAnimationSupport()` in `kittyProtocol`);
dropped or coalesced delta frames have their damage unioned into the next
frame so no region goes stale. On shared-filesystem terminals (probed by
`detectKittyFileTransferSupport()`), payloads travel as `t=t` temp files
(named by `frameFiles`) instead of inline base64, and the escape sequence
carries only the file path.

Supporting modules: `CellRenderer` (block-glyph fallback rendering with cell-level diffing), `rendererOptions` (shared option resolution and frame-buffer, gamma, and post-processing setup for both renderers), `displayLayout` (centered, aspect-correct cell-grid placement shared by both renderers), `kittyEncode` (scales, PNG-encodes, and chunks frames into complete protocol payloads; runs inside the worker, or on the main thread as a sync fallback), `kittyProtocol` (escape sequences), `dirtyRect` (changed-region bounding boxes for delta frames), `frameFiles` (temp-file naming and stale-file sweep for file-based transmission), `png` (chunk encoding), `fitToTerminal` and `aspect` (sizing), `color` (gamma tables, RGB15 to RGB24), `ansi` (cursor control), `terminal` (cell pixel size detection), `postProcessing` (CRT effects), `helpers` (small shared utilities). Root `src/types.ts` and `src/consts.ts` hold cross-module types (`ColorSpace`, `FrameBuffer`) and constants.

Deeper technical detail (protocol usage, measured optimizations) lives in `docs/TRD.md`.

## Public API Surface

`src/index.ts` exports two tiers, mirroring the "Which layer do I want?" section in `docs/TRD.md`:

- **Tier 1 (main API)**: `Screen`/`createScreen`, their option types, and the capability probe trios (`detect*`/`get*`/`reset*`)
- **Tier 2 (building blocks)**: complete, composable units for assembling a custom render pipeline: both renderers, `KittyFrameEncoder`, the worker client and its message contract (public because `workerFactory` is a documented option), protocol sequence builders, layout/sizing math, dirty rects, `OutputGate`, post-processing, and color quantization

The test for adding an export: could a developer building their own pipeline use this unit on its own? Internals that only serve the library's own plumbing stay private, including byte-level codec helpers (`png`), probe-handshake parsers, trivial glyph/SGR constants, option-default constants (the README options table documents defaults), and the `ansi`, `frameFiles`, and `helpers` modules. Whenever the surface changes, update the "Low-level exports" list in `docs/TRD.md` to match.

## Gotchas

- **Zero runtime dependencies**: this library ships with none (stated in the README as a design constraint). Never add a runtime dependency; hand-roll small utilities instead.
- **`minimumReleaseAge` install policy**: `pnpm-workspace.yaml` blocks package versions published less than 7 days ago. If `pnpm add` or `pnpm update` fails to resolve a brand-new release, pin an older version instead of fighting the resolver.
- **AGENTS.md is a symlink to CLAUDE.md**: edit CLAUDE.md only; never create a separate AGENTS.md.

## Git

- **Never create merge commits**: When integrating a branch, always rebase. Use `git rebase`, `git pull --rebase`, or `git merge --ff-only` to keep history linear. Never run a plain `git merge` that produces a merge commit.

## Coding Standards

- **Package manager**: Use `pnpm` for all package management (install, add, remove, etc.)
- **ESM imports only**: Always use `import` syntax, never `require()`. This is an ESM project and `require` will throw `ReferenceError: require is not defined`
- **Explicit `.ts` extensions on relative imports**: Write `from "./consts.ts"` and `from "../Game/index.ts"`, never extensionless `from "./consts"`. Sources must run under plain `node` (native type stripping does no extensionless or directory resolution). Enforced by ESLint
- **Erasable syntax only**: `erasableSyntaxOnly` is on in tsconfig. No constructor parameter properties (`constructor(private foo: T)`), enums, or namespaces; declare fields explicitly and assign in the constructor
- **Arrow functions**: Use `const foo = () => { ... }` (enforced by ESLint, auto-fixable with `pnpm lint:fix`)
- **Reserve `use` prefix for React hooks**: The `useFoo` naming convention is reserved for React hooks. For boolean options or flags, use names like `systemFont`, `enableCache`, or `withValidation` instead of `useSystemFont`, `useCache`, or `useValidation`
- **Named constants**: Use `const HEADER_SIZE = 16` not magic numbers
- **Numeric separators**: Use underscore separators for numbers 1000 and above for readability (`1_500`, `44_100`, `100_000`)
- **DRY (Don't Repeat Yourself)**: When a pattern appears 3+ times, extract it into a helper function. This improves readability and maintainability without impacting performance
- **Module structure**: Always create modules as directories with `index.ts`, never as single `moduleName.ts` files. Name the directory after the primary export (class, function, or concept). This provides a consistent location for related files:

  ```
  # GOOD - directory structure allows for growth
  src/
    TitleScreen/
      index.ts       # exports showTitleScreen()
      tests.ts  # tests for the module
      consts.ts      # LOGO, PROMPT_TEXT, etc.
    Game/
      index.ts       # exports Game class
      consts.ts      # TICK_RATE, MAX_SPEED, etc.
      types.ts       # GameState, GameConfig interfaces

  # BAD - single files have nowhere for related code to go
  src/
    TitleScreen.ts
    Game.ts
  ```

  Standard files within a module directory:
  - `index.ts` - Main module implementation and exports (no constants or type definitions here)
  - `tests.ts` - Tests for the module
  - `consts.ts` - **All** module-specific constants (primitives, arrays, objects)
  - `types.ts` - **All** type definitions, interfaces, and type guards

- **Keep index.ts focused on implementation**: The `index.ts` file should only contain the main implementation (classes, functions). All constants go in `consts.ts` and all types/interfaces/type guards go in `types.ts`. This keeps files focused and makes it easy to find things:

  ```typescript
  // BAD - constants defined in index.ts
  // Game/index.ts
  const DEFAULT_SPEED = 10;
  const MAX_PLAYERS = 4;
  export class Game { ... }

  // GOOD - constants in consts.ts, imported into index.ts
  // Game/consts.ts
  export const DEFAULT_SPEED = 10;
  export const MAX_PLAYERS = 4;

  // Game/index.ts
  import { DEFAULT_SPEED, MAX_PLAYERS } from "./consts.ts";
  export class Game { ... }
  ```

- **Re-export types and consts from index.ts**: Each module's `index.ts` should re-export all types and consts from `types.ts` and `consts.ts`. External code should import from the module, not directly from internal files:

  ```typescript
  // GOOD - import from the module's index
  import { TICK_RATE, GameState } from "../Game/index.ts";

  // BAD - importing directly from internal module files
  import { TICK_RATE } from "../Game/consts.ts";
  import type { GameState } from "../Game/types.ts";
  ```

  In `Game/index.ts`:

  ```typescript
  import { DEFAULT_SPEED, MAX_PLAYERS } from "./consts.ts";
  import type { GameState } from "./types.ts";

  export * from "./consts.ts";
  export * from "./types.ts";

  // ... implementation using the imported constants and types
  ```

- **JSDoc**: Skip `@param`/`@returns` tags (TypeScript provides types); use inline comments if needed
- **Doc comments on interface/type properties**: Use a `/** ... */` block comment above the property, not a trailing `//` comment. Editors surface `/** */` on hover; trailing `//` comments are invisible until you scroll to that line:

  ```typescript
  // GOOD - shows on hover in editors
  export interface KittyRendererOptions extends EffectOptions {
    /** Scale factor for the image (undefined = auto-fit to terminal) */
    scale?: number;
  }

  // BAD - trailing comment doesn't show on hover
  export interface KittyRendererOptions extends EffectOptions {
    scale?: number; // Scale factor for the image (undefined = auto-fit to terminal)
  }
  ```

- **Export interfaces**: Almost always export `interface`/`type` declarations, even ones that look internal to a module. Consumers (and tests) frequently need to reference a function's options or return shape, and an unexported type forces them to redefine or `ReturnType<>`/`Parameters<>` it instead:

  ```typescript
  // BAD - unexported, so callers can't name these types
  interface FitToTerminalOptions {
    availableCols: number;
    availableRows: number;
    aspectRatio: number;
    requestedWidth?: number;
    requestedHeight?: number;
  }

  interface DisplaySize {
    width: number;
    height: number;
  }

  // GOOD - exported so callers can use the types directly
  export interface FitToTerminalOptions {
    availableCols: number;
    availableRows: number;
    aspectRatio: number;
    requestedWidth?: number;
    requestedHeight?: number;
  }

  export interface DisplaySize {
    width: number;
    height: number;
  }
  ```

- **Loading indicators**: Delay by ~1 second to avoid flash for fast operations
- **Intl API**: Prefer `Intl.DateTimeFormat`, `Intl.NumberFormat`, etc. over manual formatting for dates, numbers, and currencies
- **Explicit conditionals for derived values**: When a value like `useTrueColor` is derived from another value like `limitColors`, use the source value in conditionals, not the derived value. This makes the logic clearer and avoids confusion:

  ```typescript
  // GOOD - explicit about what each branch handles
  if (this.limitColors === 16) {
    /* ANSI 16 */
  } else if (this.limitColors === 256) {
    /* ANSI 256 */
  } else {
    /* True color (limitColors === 0) */
  }

  // BAD - confusing because useTrueColor is derived from limitColors
  if (this.limitColors === 16) {
    /* ANSI 16 */
  } else if (this.useTrueColor) {
    /* True color */
  } else {
    /* ANSI 256 */
  }
  ```

- **Type guards over type assertions**: Never use `as` type assertions on values with unknown runtime types. Write custom type guards (this library has zero runtime dependencies, so hand-roll them; see `src/kittyEncode/types.ts` for existing `isString`/`isPlainObject` guards to copy - they are module-private, not exported):

  ```typescript
  // GOOD - type guard validates at runtime
  const isString = (value: unknown): value is string => typeof value === "string";

  if (isString(value)) {
    config.name = value;
  }

  // BAD - blind cast assumes type without validation
  config.name = value as string;
  ```

  For union types (e.g., `ColorSpace` in `src/types.ts`), create a type guard that validates the actual values, not just the primitive type:

  ```typescript
  // GOOD - validates the value is one of the allowed options
  if (isColorSpace(value)) {
    config.colorSpace = value; // No cast needed
  }

  // BAD - isString only checks primitive type, not valid union values
  if (isString(value)) {
    config.colorSpace = value as ColorSpace; // Still a blind cast!
  }
  ```

  When creating type guards for union types, use the named type in the return type annotation - don't hardcode the union:

  ```typescript
  // GOOD - uses the named type
  import type { ColorSpace } from "../types.ts";

  const COLOR_SPACES: readonly ColorSpace[] = ["rgb15", "rgb24"];

  export const isColorSpace = (value: unknown): value is ColorSpace =>
    isString(value) && COLOR_SPACES.includes(value as ColorSpace);

  // BAD - hardcodes the union type (duplicates the type definition)
  export const isColorSpace = (value: unknown): value is "rgb15" | "rgb24" => {
    // ...
  };
  ```

- **Typed errors over string messages**: When throwing errors, create a custom error class with a typed `code` property instead of using plain `Error` with string messages. This enables type-safe error handling:

  ```typescript
  // GOOD - typed error with machine-readable code
  type MyErrorCode = "NOT_FOUND" | "PERMISSION_DENIED" | "TIMEOUT";

  class MyError extends Error {
    readonly code: MyErrorCode;
    constructor(code: MyErrorCode) {
      super(code);
      this.name = "MyError";
      this.code = code;
    }
  }

  const isMyError = (error: unknown): error is MyError => {
    return error instanceof MyError;
  };

  // Usage - callers get autocomplete and type checking
  try {
    await doSomething();
  } catch (error) {
    if (isMyError(error)) {
      switch (error.code) {
        case "NOT_FOUND": // TypeScript knows valid codes
        // ...
      }
    }
  }

  // BAD - string messages aren't type-safe
  throw new Error("Not found");
  throw new Error("Permission denied");
  ```

- **Tests verify behavior, not implementation**: Tests should verify that code works correctly, not enshrine implementation details. Never write tests that just check constant values - if a constant matters, test the behavior it affects:

  ```typescript
  // BAD - tests implementation detail, provides no value
  it("should have expected default value", () => {
    expect(MAX_FRAMES_BEHIND).toBe(60);
  });

  // GOOD - tests actual behavior that depends on the constant
  it("should trigger catchup when too far behind", () => {
    // Simulate being far behind and verify the sync behavior
    for (let i = 0; i < 70; i++) {
      syncManager.advanceFrame();
    }
    expect(syncManager.needsCatchup).toBe(true);
  });
  ```

## Documentation Style

Applies to all prose: README, doc comments, JSDoc, commit messages, and PR descriptions.

- **No emdashes**: Never use emdashes (—) or spaced hyphens as emdash substitutes. Restructure into separate sentences, or use a comma, colon, or parentheses instead:

  ```
  # BAD
  The encoder is fast — roughly 2ms per frame — so it never blocks the render loop.

  # GOOD
  The encoder is fast (roughly 2ms per frame), so it never blocks the render loop.
  ```

- **No semicolons or mid-sentence colons**: Human-written docs rarely use them, AI-generated ones lean on them constantly. Split into separate sentences instead. A colon that introduces a list, example, or code block is fine:

  ```
  # BAD
  The protocol displays images; sustaining motion is your problem: diffing, encoding, and backpressure.

  # GOOD
  The protocol only displays images. Sustaining motion means building frame
  diffing, encoding, and backpressure yourself.
  ```

- **No AI-isms**: Avoid filler words and hype phrasing that reads as machine-generated. Say what the thing does in plain, direct language:
  - Banned words: "delve", "leverage" (as a verb; use "use"), "seamless", "seamlessly", "robust", "powerful", "cutting-edge", "blazingly fast", "supercharge", "elevate", "streamline", "harness" (as a verb), "unlock", "empower", "crucial", "comprehensive", "furthermore", "moreover", "additionally" (as a sentence opener)
  - Banned constructions: "It's not just X, it's Y", "Whether you're X or Y", "In today's world of...", "Let's dive in", "the beauty of X is", rhetorical questions as section openers
  - No summary padding: skip closing paragraphs like "In conclusion" or "With these tools in place, you're ready to..."

  ```
  # BAD
  Screen provides a robust, seamless API that empowers you to effortlessly
  push frames to the terminal. Whether you're building a game or a video player,
  it's not just fast, it's blazingly fast.

  # GOOD
  Screen pushes frames to the terminal over the Kitty graphics protocol.
  Frame encoding takes about 2ms, so it can sustain 60fps playback.
  ```

- **Concrete over promotional**: Prefer measurable claims ("encodes a 720p frame in 2ms") over adjectives ("high-performance"). If a claim has no number or specific behavior behind it, cut it.
