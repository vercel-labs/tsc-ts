// Runtime helpers emitted at the top of a file, or imported from tslib with `importHelpers`.
/** A runtime helper such as `__decorate`, emitted once at the top of a file or scope. */
export class EmitHelper {
  readonly name: string;
  /** Emitted in the scope that uses it rather than at the top of the file. */
  readonly scoped: boolean;
  readonly text: string;
  /** Lower values are emitted first; helpers without a priority come last. */
  readonly priority: number;
  readonly dependencies: readonly EmitHelper[];
  readonly importName: string;
  /** For helpers that declare a file-level unique name: the base name, written in place of each `{name}` in `text`. */
  readonly uniqueName: string;

  constructor(
    name: string,
    scoped: boolean,
    text: string,
    priority: number,
    dependencies: readonly EmitHelper[],
    importName: string,
    uniqueName: string,
  ) {
    this.name = name;
    this.scoped = scoped;
    this.text = text;
    this.priority = priority;
    this.dependencies = dependencies;
    this.importName = importName;
    this.uniqueName = uniqueName;
  }
}

export const noPriority = -1;

export function compareEmitHelpers(x: EmitHelper, y: EmitHelper): number {
  if (x === y || x.priority === y.priority) return 0;
  if (x.priority === noPriority) return 1;
  if (y.priority === noPriority) return -1;
  return x.priority - y.priority;
}

const createBindingHelper = new EmitHelper(
  'typescript:commonjscreatebinding',
  false,
  `var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));`,
  1,
  [],
  '__createBinding',
  '',
);

const setModuleDefaultHelper = new EmitHelper(
  'typescript:commonjscreatevalue',
  false,
  `var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});`,
  1,
  [],
  '__setModuleDefault',
  '',
);

export const importStarHelper = new EmitHelper(
  'typescript:commonjsimportstar',
  false,
  `var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();`,
  2,
  [createBindingHelper, setModuleDefaultHelper],
  '__importStar',
  '',
);

export const importDefaultHelper = new EmitHelper(
  'typescript:commonjsimportdefault',
  false,
  `var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};`,
  noPriority,
  [],
  '__importDefault',
  '',
);

export const exportStarHelper = new EmitHelper(
  'typescript:export-star',
  false,
  `var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};`,
  2,
  [createBindingHelper],
  '__exportStar',
  '',
);

export const rewriteRelativeImportExtensionsHelper = new EmitHelper(
  'typescript:rewriteRelativeImportExtensions',
  false,
  `var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx, extraExtensions, ignoreCase) {
    if (typeof path === "string" && /^\\.\\.?\\//.test(path)) {
        if (extraExtensions) {
            for (var extension in extraExtensions) {
                var suffix = path.slice(-extension.length);
                if (suffix === extension || ignoreCase && suffix.toLowerCase() === extension.toLowerCase()) {
                    var output = extraExtensions[extension];
                    return output === extension ? path : path.slice(0, -extension.length) + output;
                }
            }
        }
        return path.replace(/\\.(tsx)$|((?:\\.d)?)((?:\\.[^./]+?)?)\\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};`,
  noPriority,
  [],
  '__rewriteRelativeImportExtension',
  '',
);

export const restHelper = new EmitHelper(
  'typescript:rest',
  false,
  `var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};`,
  noPriority,
  [],
  '__rest',
  '',
);

export const classPrivateFieldGetHelper = new EmitHelper(
  'typescript:classPrivateFieldGet',
  false,
  `var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};`,
  noPriority,
  [],
  '__classPrivateFieldGet',
  '',
);

export const classPrivateFieldSetHelper = new EmitHelper(
  'typescript:classPrivateFieldSet',
  false,
  `var __classPrivateFieldSet = (this && this.__classPrivateFieldSet) || function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
};`,
  noPriority,
  [],
  '__classPrivateFieldSet',
  '',
);

export const classPrivateFieldInHelper = new EmitHelper(
  'typescript:classPrivateFieldIn',
  false,
  `var __classPrivateFieldIn = (this && this.__classPrivateFieldIn) || function(state, receiver) {
    if (receiver === null || (typeof receiver !== "object" && typeof receiver !== "function")) throw new TypeError("Cannot use 'in' operator on non-object");
    return typeof state === "function" ? receiver === state : state.has(receiver);
};`,
  noPriority,
  [],
  '__classPrivateFieldIn',
  '',
);

export const makeTemplateObjectHelper = new EmitHelper(
  'typescript:makeTemplateObject',
  false,
  `var __makeTemplateObject = (this && this.__makeTemplateObject) || function (cooked, raw) {
    if (Object.defineProperty) { Object.defineProperty(cooked, "raw", { value: raw }); } else { cooked.raw = raw; }
    return cooked;
};`,
  0,
  [],
  '__makeTemplateObject',
  '',
);

// ES2018 helpers

// ESNext helpers

export const addDisposableResourceHelper = new EmitHelper(
  'typescript:addDisposableResource',
  false,
  `var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};`,
  noPriority,
  [],
  '__addDisposableResource',
  '',
);

export const disposeResourcesHelper = new EmitHelper(
  'typescript:disposeResources',
  false,
  `var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});`,
  noPriority,
  [],
  '__disposeResources',
  '',
);
