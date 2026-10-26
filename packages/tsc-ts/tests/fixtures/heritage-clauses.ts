// A class's `implements` and an interface's `extends` hold type references when an element is an entity
// name with optional type arguments, and expressions with type arguments otherwise.
class C extends Base<number> implements Contract<string>, ns.Shape<1>, Opt?.Chain {}
interface I extends Parent<boolean>, a.b.C {}
interface Invalid implements Recovery {}
interface MissingExtends extends A. {}
class MissingImplements implements B. {}
class Calls implements f() {}
const E = class extends Base implements I {};
