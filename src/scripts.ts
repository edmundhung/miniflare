import assert from "assert";
import { promises as fs } from "fs";
import path from "path";
import vm, { ModuleLinker } from "vm";
import { cjsToEsm } from "cjstoesm";
import {
  CompilerOptions,
  ModuleKind,
  ScriptTarget,
  transpileModule,
} from "typescript";
import { MiniflareError } from "./helpers";
import { ProcessedModuleRule, stringScriptPath } from "./options";

export function createScriptContext(sandbox: vm.Context): vm.Context {
  return vm.createContext(sandbox, {
    codeGeneration: { strings: false },
  });
}

export class ScriptBlueprint {
  constructor(public readonly code: string, public readonly fileName: string) {}

  async buildScript(context: vm.Context): Promise<ScriptScriptInstance> {
    const script = new vm.Script(this.code, { filename: this.fileName });
    return new ScriptScriptInstance(context, script);
  }

  async buildModule<Exports = any>(
    context: vm.Context,
    linker: vm.ModuleLinker
  ): Promise<ModuleScriptInstance<Exports>> {
    if (!("SourceTextModule" in vm)) {
      throw new MiniflareError(
        "Modules support requires the --experimental-vm-modules flag"
      );
    }
    const module = new vm.SourceTextModule<Exports>(this.code, {
      identifier: this.fileName,
      context,
    });
    await module.link(linker);
    return new ModuleScriptInstance(module);
  }
}

export interface ScriptInstance {
  run(): Promise<void>;
}

export class ScriptScriptInstance implements ScriptInstance {
  constructor(private context: vm.Context, private script: vm.Script) {}

  async run(): Promise<void> {
    this.script.runInContext(this.context);
  }
}

export class ModuleScriptInstance<Exports = any> implements ScriptInstance {
  constructor(private module: vm.SourceTextModule<Exports>) {}

  async run(): Promise<void> {
    await this.module.evaluate({ breakOnSigint: true });
  }

  get exports(): Exports {
    return this.module.namespace;
  }
}

const commonJsTransformer = cjsToEsm();
const commonJsCompilerOptions: CompilerOptions = {
  allowJs: true,
  module: ModuleKind.ESNext,
  sourceMap: true,
  target: ScriptTarget.ES2018,
};

export class ScriptLinker {
  readonly referencedPaths = new Set<string>();
  private _referencedPathsSizes = new Map<string, number>();
  private _moduleCache = new Map<string, vm.Module>();
  readonly extraSourceMaps = new Map<string, string>();
  readonly linker: ModuleLinker;

  constructor(private moduleRules: ProcessedModuleRule[]) {
    this.linker = this._linker.bind(this);
  }

  get referencedPathsTotalSize(): number {
    // Make sure we only include each module once, even if it's referenced
    // from multiple scripts
    const sizes = Array.from(this._referencedPathsSizes.values());
    return sizes.reduce((total, size) => total + size, 0);
  }

  private async _linker(
    specifier: string,
    referencingModule: vm.Module
  ): Promise<vm.Module> {
    const errorBase = `Unable to resolve "${path.relative(
      "",
      referencingModule.identifier
    )}" dependency "${specifier}"`;

    if (referencingModule.identifier === stringScriptPath) {
      throw new MiniflareError(
        `${errorBase}: imports unsupported with string script`
      );
    }

    // Get path to specified module relative to referencing module and make
    // sure it's within the root modules path
    const modulePath = path.resolve(
      path.dirname(referencingModule.identifier),
      specifier
    );
    const cached = this._moduleCache.get(modulePath);
    if (cached) return cached;

    // Find first matching module rule
    const rule = this.moduleRules.find((rule) =>
      rule.include.some((regexp) => modulePath.match(regexp))
    );
    if (rule === undefined) {
      throw new MiniflareError(`${errorBase}: no matching module rules`);
    }

    // Load module based on rule type
    this.referencedPaths.add(modulePath);
    const data = await fs.readFile(modulePath);
    this._referencedPathsSizes.set(modulePath, data.byteLength);
    const moduleOptions = {
      identifier: modulePath,
      context: referencingModule.context,
    };
    let result: vm.Module;
    switch (rule.type) {
      case "ESModule":
        result = new vm.SourceTextModule(data.toString("utf8"), moduleOptions);
        break;
      case "CommonJS":
        // TODO: (low priority) try do this without TypeScript
        // Convert CommonJS module to an ESModule one
        const transpiled = transpileModule(data.toString("utf8"), {
          transformers: commonJsTransformer,
          compilerOptions: commonJsCompilerOptions,
          fileName: modulePath,
        });
        // Store ESModule -> CommonJS source map
        assert(transpiled.sourceMapText);
        this.extraSourceMaps.set(modulePath, transpiled.sourceMapText);
        result = new vm.SourceTextModule(transpiled.outputText, moduleOptions);
        break;
      case "Text":
        result = new vm.SyntheticModule<{ default: string }>(
          ["default"],
          function () {
            this.setExport("default", data.toString("utf8"));
          },
          moduleOptions
        );
        break;
      case "Data":
        result = new vm.SyntheticModule<{ default: ArrayBuffer }>(
          ["default"],
          function () {
            this.setExport(
              "default",
              data.buffer.slice(
                data.byteOffset,
                data.byteOffset + data.byteLength
              )
            );
          },
          moduleOptions
        );
        break;
      case "CompiledWasm":
        result = new vm.SyntheticModule<{ default: WebAssembly.Module }>(
          ["default"],
          function () {
            this.setExport("default", new WebAssembly.Module(data));
          },
          moduleOptions
        );
        break;
      default:
        throw new MiniflareError(
          `${errorBase}: ${rule.type} modules are unsupported`
        );
    }
    this._moduleCache.set(modulePath, result);
    return result;
  }
}
