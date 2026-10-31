// Constructs classes once that some drivers never create, so scriptc lowers the code that refers
// to them: the binder's classes in drivers that never bind, transform-only nodes in drivers
// that never emit, and source maps in drivers that only print text.
import { Identifier, PartiallyEmittedExpression } from '../compiler/ast.js';
import { FlowFlags, FlowNode } from '../compiler/flow.js';
import { SourceMapGenerator } from '../compiler/sourcemap.js';
import { Symbol, SymbolFlags } from '../compiler/symbol.js';
import { IdentifierName } from '../compiler/identifier-name.js';

export const loweredFlowNode = new FlowNode(FlowFlags.None, undefined, undefined);
export const loweredSymbol = new Symbol(SymbolFlags.None, '');
export const loweredPartiallyEmittedExpression = new PartiallyEmittedExpression(new Identifier(new IdentifierName('')));
export const loweredSourceMapGenerator = new SourceMapGenerator('', '', '', false, '');
