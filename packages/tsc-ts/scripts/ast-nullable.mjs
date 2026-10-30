// Members of tools/scripts/tsc/ast.json that the schema marks required but tsc-ts's parser can leave unset, as
// `<node>.<member>`. The node classes (scripts/generate-ast.mjs) and the API's node interfaces
// (scripts/generate-api.mjs) declare them optional.
export const nullable = new Set([
  'PropertySignatureDeclaration.Type',
  'PropertySignatureDeclaration.Initializer',
  'PropertyAssignment.Type',
  'ShorthandPropertyAssignment.Type',
  'ExportAssignment.Type',
  'JSDocTemplateTag.Constraint',
  'TaggedTemplateExpression.QuestionDotToken',
  'BinaryExpression.Type',
  'ImportAttribute.name',
  'BindingElement.name',
  'CaseOrDefaultClause.Expression',
  'IndexSignatureDeclaration.Type',
  'JSDocSeeTag.NameExpression',
  'JSDocNameReference.name',
  // tsgo's node builder leaves it unset.
  'ArrowFunction.EqualsGreaterThanToken',
]);
