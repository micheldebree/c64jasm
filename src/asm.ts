
import opcodes from './opcodes'
import * as path from 'path'
const importFresh = require('import-fresh');

import { readFileSync } from 'fs'
import { toHex16 } from './util'
import * as ast from './ast'
import { SourceLoc } from './ast'
import ParseCache from './parseCache'
import { DebugInfoTracker } from './debugInfo';

interface Error {
    loc: SourceLoc,
    msg: string
}

interface LabelAddr {
    addr: number,
    loc: SourceLoc
}

class SeenLabels {
    seenLabels = new Map<string, ast.Label>();

    clear() {
        this.seenLabels.clear();
    }

    find(name: string) {
        return this.seenLabels.get(name);
    }

    declare(name: string, sym: ast.Label) {
        this.seenLabels.set(name, sym);
    }
}

class Labels {
    labels: {[index: string]: LabelAddr} = {}
    macroCount = 0
    labelPrefix: string[] = []

    startPass(): void {
        this.macroCount = 0;
    }

    pushLabelScope(name: string): void {
        this.labelPrefix.push(name)
    }

    popMacroExpandScope(): void {
        this.labelPrefix.pop();
    }

    pushMacroExpandScope(name: string): void {
        this.labelPrefix.push(`${name}/${this.macroCount}`)
        this.macroCount++;
    }

    popLabelScope(): void {
        this.labelPrefix.pop();
    }

    makeScopePrefix(maxDepth: number): string {
        if (this.labelPrefix.length === 0) {
            return ''
        }
        return this.labelPrefix.slice(0, maxDepth).join('/');
    }

    currentScopePrefix(): string {
        return this.makeScopePrefix(this.labelPrefix.length)
    }

    currentPrefixName(name: string): string {
        const prefix = this.currentScopePrefix();
        if (prefix == '') {
            return name;
        }
        return `${prefix}/${name}`
    }

    prefixName(name: string, depth: number): string {
        const prefix = this.makeScopePrefix(depth);
        if (prefix == '') {
            return name;
        }
        return `${prefix}/${name}`
    }

    add(name: string, addr: number, loc: SourceLoc): void {
        const lbl: LabelAddr = {
            addr,
            loc
        }
        const prefixedName = this.currentPrefixName(name);
        this.labels[prefixedName] = lbl
    }

    // Find a label with fully specified scope path
    findFq(nameFq: string): LabelAddr {
        return this.labels[nameFq];
    }

    find(name: string): LabelAddr | undefined {
        const scopeDepth = this.labelPrefix.length;
        if (scopeDepth == 0) {
            return this.labels[name];
        }
        for (let depth = scopeDepth; depth >= 0; depth--) {
            const pn = this.prefixName(name, depth);
            const lbl = this.labels[pn];
            if (lbl) {
                return lbl;
            }
        }
        return undefined;
    }
}

interface Constant {
    arg: ast.MacroArg,
    value: any
}

class SymbolTab<S> {
    symbols: Map<string, S> = new Map();

    add = (name: string, s: S) => {
        this.symbols.set(name, s);
    }

    find (name: string): S|undefined {
        return this.symbols.get(name);
    }
}

class ScopeStack<S> {
    stack: SymbolTab<S>[] = [];

    push = () => {
        this.stack.push(new SymbolTab<S>());
    }

    pop = () => {
        this.stack.pop();
    }

    find (name: string): S | undefined {
        const last = this.stack.length-1;
        for (let idx = last; idx >= 0; idx--) {
            const elt = this.stack[idx].find(name);
            if (elt) {
                return elt;
            }
        }
        return undefined;
    }

    add = (name: string, sym: S) => {
        const last = this.stack.length-1;
        this.stack[last].add(name, sym);
    }
}

class Scopes {
    labels = new Labels();
    seenLabels = new SeenLabels();
    macros = new ScopeStack<ast.StmtMacro>();

    constructor () {
        this.macros.push();
    }

    startPass(): void {
        this.labels.startPass();
        this.seenLabels.clear();
    }

    pushLabelScope(name: string): void {
        this.labels.pushLabelScope(name);
    }

    popLabelScope(): void {
        this.labels.popLabelScope();
    }

    pushMacroExpandScope(macroName: string): void {
        this.labels.pushMacroExpandScope(macroName);
    }

    popMacroExpandScope(): void {
        this.labels.popMacroExpandScope();
    }

    findMacro(name: string): ast.StmtMacro | undefined {
        return this.macros.find(name);
    }

    addMacro(name: string, macro: ast.StmtMacro): void {
        return this.macros.add(name, macro);
    }

    addLabel(name: string, addr: number, loc: SourceLoc): void {
        this.labels.add(name, addr, loc);
    }

    findLabel(name: string): LabelAddr | undefined {
        return this.labels.find(name);
    }

    findLabelFq(name: string): LabelAddr {
        return this.labels.findFq(name);
    }

    findSeenLabel(name: string): ast.Label|undefined {
        return this.seenLabels.find(this.labels.currentPrefixName(name));
    }

    declareLabelSymbol(symbol: ast.Label, codePC: number): boolean {
        const { name, loc } = symbol
        const labelFq = this.labels.currentPrefixName(name);
        this.seenLabels.declare(labelFq, symbol);
        const oldLabel = this.findLabelFq(labelFq);
        if (oldLabel === undefined) {
            this.addLabel(name, codePC, loc);
            return false;
        }
        // If label address has changed change, need one more pass
        if (oldLabel.addr !== codePC) {
            this.addLabel(name, codePC, loc);
            return true;
        }
        return false;
    }

    dumpLabels(codePC: number) {
        const labels = Object.keys(this.labels.labels).map(name => {
            return {
                name,
                ...this.labels.labels[name],
                size: 0
            }
        })
        const sortedLabels = labels.sort((a, b) => {
            return a.addr - b.addr;
        })

        const numLabels = sortedLabels.length;
        if (numLabels > 0) {
            for (let i = 1; i < numLabels; i++) {
                sortedLabels[i-1].size = sortedLabels[i].addr - sortedLabels[i-1].addr;
            }
            const last = sortedLabels[numLabels-1];
            last.size = codePC - last.addr;
        }

        return sortedLabels;
    }
}

function isTrueVal(cond: number | boolean): boolean {
    return (cond === true || cond != 0);
}

function makeCompileLoc(filename: string) {
    // SourceLoc can be undefined here if parse is executed out of AST
    // (e.g., source file coming from CLI), so make up an error loc for it.
    return {
        source: filename,
        start: { offset: 0, line: 0, column: 0 },
        end: { offset: 0, line: 0, column: 0 }
    };
}

interface BranchOffset {
    offset: number;
    loc: SourceLoc;
}

const runBinopNum = (a: any, b: any, f: (a: number, b: number) => number | boolean) => {
    // TODO a.type, b.type must be literal
    const res = f(a as number, b as number);
    if (typeof res == 'boolean') {
        return res ? 1 : 0;
    }
    return res;
}

class Assembler {
    // TODO this should be a resizable array instead
    binary: number[] = [];

    parseCache = new ParseCache();
    pluginCache = new Map();

    includeStack: string[] = [];
    codePC = 0;
    pass = 0;
    needPass = false;
    scopes = new Scopes();
    variables = new ScopeStack<Constant>();
    errorList: Error[] = [];
    outOfRangeBranches: BranchOffset[] = [];

    // PC<->source location tracking for debugging support.  Reset on each pass
    debugInfo = new DebugInfoTracker();

    prg (): Buffer {
      // 1,8 is for encoding the $0801 starting address in the .prg file
      return Buffer.from([1, 8].concat(this.binary))
    }

    parse (filename: string, loc: SourceLoc | undefined) {
        const l = loc == undefined ? makeCompileLoc(filename) : loc;
        return this.parseCache.parse(filename, loc, ((fname, _loc) => this.guardedReadFileSync(fname, l)));
    }

    // Cache plugin require's so that we fresh require() them only in the first pass.
    // importFresh is somewhat slow because it blows through Node's cache
    // intentionally.  We don't want it completely cached because changes to plugin
    // code must trigger a recompile and in that case we want the plugins really
    // reloaded too.
    requirePlugin(fname: string): any {
        const p = this.pluginCache.get(fname);
        if (p !== undefined) {
            return p;
        }
        const newPlugin = importFresh(path.resolve(this.makeSourceRelativePath(fname)));
        this.pluginCache.set(fname, newPlugin);
        return newPlugin;
    }

    peekSourceStack (): string {
        const len = this.includeStack.length;
        return this.includeStack[len-1];
    }

    pushSource (fname: string): void {
        this.includeStack.push(fname);
    }

    popSource (): void {
        this.includeStack.pop();
    }

    anyErrors (): boolean {
        return this.errorList.length !== 0;
    }

    errors = () => {
        return this.errorList.map(({loc, msg}) => {
            let formatted = `<unknown>:1:1: error: ${msg}`
            if (loc) {
                formatted = `${loc.source}:${loc.start.line}:${loc.start.column}: error: ${msg}`
            }
            return {
                loc,
                msg,
                formatted
            }
        })
    }

    addError (msg: string, loc: SourceLoc): void {
        this.errorList.push({ msg, loc });
    }

    error (msg: string, loc: SourceLoc): never {
        this.addError(msg, loc);
        const err = new Error('Compilation failed');
        err.name = 'semantic';
        throw err;
    }

    startPass (pass: number): void {
      this.codePC = 0x801;
      this.pass = pass;
      this.needPass = false;
      this.binary = [];
      this.scopes.startPass();
      this.outOfRangeBranches = [];
      this.debugInfo = new DebugInfoTracker();
    }

    pushVariableScope (): void {
        this.scopes.macros.push();
        this.variables.push();
    }

    popVariableScope (): void {
        this.variables.pop();
        this.scopes.macros.pop();
    }

    emitBasicHeader () {
      this.emit(0x0c);
      this.emit(0x08);
      this.emit(0x00);
      this.emit(0x00);
      this.emit(0x9e);
      const addr = 0x80d
      const dividers = [10000, 1000, 100, 10, 1]
      dividers.forEach(div => {
        if (addr >= div) {
          this.emit(0x30 + (addr / div) % 10)
        }
      });
      this.emit(0);
      this.emit(0);
      this.emit(0);
    }

    emitBinary (ast: ast.StmtBinary): void {
        const { filename } = ast
        const fname = this.makeSourceRelativePath(this.evalExpr(filename));
        const buf: Buffer = this.guardedReadFileSync(fname, ast.loc);

        let offset = 0
        let size = buf.byteLength
        if (ast.size !== null) {
            if (ast.offset !== null) {
                offset = this.evalExpr(ast.offset);
            }
            if (ast.size !== null) {
                const sizeExprVal = this.evalExpr(ast.size);
                size = sizeExprVal;
            }
        }
        // TODO buffer overflow
        for (let i = 0; i < size; i++) {
            this.emit(buf.readUInt8(i + offset));
        }
    }

    evalExpr(node: ast.Expr): any {
        switch (node.type) {
            case 'binary': {
                const left = this.evalExpr(node.left);
                const right = this.evalExpr(node.right);
                switch (node.op) {
                    case '+': return  runBinopNum(left, right, (a,b) => a + b)
                    case '-': return  runBinopNum(left, right, (a,b) => a - b)
                    case '*': return  runBinopNum(left, right, (a,b) => a * b)
                    case '/': return  runBinopNum(left, right, (a,b) => a / b)
                    case '%': return  runBinopNum(left, right, (a,b) => a % b)
                    case '&': return  runBinopNum(left, right, (a,b) => a & b)
                    case '|': return  runBinopNum(left, right, (a,b) => a | b)
                    case '^': return  runBinopNum(left, right, (a,b) => a ^ b)
                    case '<<': return runBinopNum(left, right, (a,b) => a << b)
                    case '>>': return runBinopNum(left, right, (a,b) => a >> b)
                    case '==': return runBinopNum(left, right, (a,b) => a == b)
                    case '!=': return runBinopNum(left, right, (a,b) => a != b)
                    case '<':  return runBinopNum(left, right, (a,b) => a <  b)
                    case '<=': return runBinopNum(left, right, (a,b) => a <= b)
                    case '>':  return runBinopNum(left, right, (a,b) => a >  b)
                    case '>=': return runBinopNum(left, right, (a,b) => a >= b)
                    case '&&': return runBinopNum(left, right, (a,b) => a && b)
                    case '||': return runBinopNum(left, right, (a,b) => a || b)
                    default:
                        throw new Error(`Unhandled binary operator ${node.op}`);
                }
            }
            case 'unary': {
                const v = this.evalExpr(node.expr);
                switch (node.op) {
                    case '+': return +v;
                    case '-': return -v;
                    case '~': return ~v;
                    default:
                        throw new Error(`Unhandled unary operator ${node.op}`);
                }
            }
            case 'literal': {
                return node.lit;
            }
            case 'array': {
                return node.list.map((v: ast.Expr) => this.evalExpr(v));
            }
            case 'ident': {
                let label = node.name
                const variable = this.variables.find(label);
                if (variable) {
                    if (variable.value !== undefined) {
                        return variable.value;
                    }
                    // Return something that we can continue compilation with in case this
                    // is a legit forward reference.
                    if (this.pass == 0) {
                        return 0; // TODO what is this unresolved business?
                    }
                    return this.error(`Couldn't resolve value for identifier '${label}'`, node.loc);
                }
                const lbl = this.scopes.findLabel(label);
                if (!lbl) {
                    if (this.pass === 1) {
                        this.error(`Undefined symbol '${label}'`, node.loc)
                    }
                    // Return a placeholder that should be resolved in the next pass
                    this.needPass = true;
                    return 0;
                }
                return lbl.addr;
            }
/*
            case 'member': {
                // TODO any
                const findObjectField = (props: any, prop: any) => {
                    for (let pi = 0; pi < props.length; pi++) {
                        const p = props[pi]
                        // TODO THIS IS SUPER MESSY!! and doesn't handle errors
                        if (typeof prop == 'object') {
                            if (p.key === prop.lit) {
                                return p.val
                            }
                        } else {
                            if (p.key === prop) {
                                return p.val;
                            }
                        }
                    }
                }
                let triedNestedLabels = undefined;
                // Does the object access match a foo.bar.baz style label access?
                // If yes, resolve as label
                if (node.type == 'member' && !node.computed) {
                    const names = [];
                    let n = node;
                    let allMatched = true;
                    do {
                        if (n.type !== 'member') {
                            allMatched = false;
                            break;
                        }
                        if (n.computed) {
                            allMatched = false;
                            break;
                        }
                        names.push(n.property)
                        n = n.object;
                    } while(n.type != 'ident');
                    if (allMatched && n.type == 'ident') {
                        names.push(n.name);
                        names.reverse();
                        const nestedLabel = names.join('/');
                        const lbl = this.scopes.findLabel(nestedLabel);
                        // If this is a legit label, treat it as such.  Otherwise fall-thru
                        // to object property lookup.
                        if (lbl) {
                            return this.evalExpr(ast.mkIdent(nestedLabel, node.loc));
                        }
                        triedNestedLabels = names.join('.');
                    }
                }
                const object = this.evalExpr(node.object);
                if (object.unresolved) {
                    const { name } = object.unresolved
                    this.error(`Cannot access properties of an unresolved symbol '${name}'`, object.unresolved.loc);
                }
                const { property, computed } = node;
                if (!computed) {
                    if (object.type !== 'object') {
                        if (triedNestedLabels !== undefined) {
                            this.error(`Couldn't resolve symbol '${triedNestedLabels}'`, node.loc)
                        }
                        this.error(` . operator can only operate on objects. Got ${object.type}.`, node.loc)
                    }
                    const elt = findObjectField(object.props, property);
                    if (elt) {
                        return elt;
                    }
                    this.error(`Object has no property '${property}'`, node.loc)
                } else {
                    // TODO assert type int
                    const idx = this.evalExpr(node.property);
                    if (object.type === 'array') {
                        return this.evalExpr(object.values[idx.lit]);
                    } else if (object.type === 'object') {
                        const elt = findObjectField(object.props, idx);
                        if (elt) {
                            return elt;
                        }
                        this.error(`Object has no property named '${property}'`, node.loc)
                    }
                    this.error('Cannot index a non-array object', object.loc)
                }
            }
*/
            case 'callfunc': {
                const callee = this.evalExpr(node.name);
                if (typeof callee !== 'function') {
                    this.error(`Callee must be a function type.  Got '${typeof callee}'`, node.loc);
                }
                const argValues = [];
                for (let argIdx = 0; argIdx < node.args.length; argIdx++) {
                    const e = this.evalExpr(node.args[argIdx]);
                    argValues.push(e);
                }
                try {
                    return callee(argValues);
                } catch(err) {
                    // TODO we lose the name for computed function names, like
                    // !use 'foo' as x
                    // x[3]()
                    // This is not really supported now though.
                    this.error(`Call to '${node.name.name}' failed with an error: ${err.message}`, node.loc);
                }
            }
            default:
                break;
        }
    }

    emit (byte: number): void {
        this.binary.push(byte);
        this.codePC += 1
    }

    emit16 (word: number): void {
        this.emit(word & 0xff);
        this.emit((word>>8) & 0xff);
    }

    // TODO shouldn't have any for opcode
    checkSingle (opcode: number | null): boolean {
        if (opcode === null) {
            return false;
        }
        this.emit(opcode)
        return true;
    }

    checkImm (param: any, opcode: number | null): boolean {
        if (opcode === null || param === null) {
            return false;
        }
        const eres = this.evalExpr(param);
        this.emit(opcode);
        this.emit(eres);
        return true;
    }

    checkAbs (param: any, opcode: number | null, bits: number): boolean {
        if (opcode === null || param === null) {
            return false;
        }
        const v = this.evalExpr(param);
        if (bits === 8) {
            if (v < 0 || v >= (1<<bits)) {
                return false;
            }
            this.emit(opcode);
            this.emit(v);
        } else {
            this.emit(opcode);
            this.emit16(v);
        }
        return true
    }

    checkBranch (param: any, opcode: number | null): boolean {
        if (opcode === null || param === null) {
            return false;
        }
        const addr = this.evalExpr(param);
        const addrDelta = addr - this.codePC - 2;
        this.emit(opcode);
        if (addrDelta > 0x7f || addrDelta < -128) {
            // Defer reporting out of 8-bit range branch targets to the end of the
            // current pass (or report nothing if we need another pass.)
            this.outOfRangeBranches.push({ loc: param.loc, offset: addrDelta });
        }
        this.emit(addrDelta & 0xff);
        return true;
      }

    setPC (valueExpr: ast.Expr): void {
        const v = this.evalExpr(valueExpr);
        if (this.codePC > v) {
            // TODO this is not great.  Actually need to track which ranges of memory have something in them.
            this.error(`Cannot set program counter to a smaller value than current (current: $${toHex16(this.codePC)}, trying to set $${toHex16(v)})`, valueExpr.loc)
        }
        while (this.codePC < v) {
            this.emit(0);
        }
    }

    guardedReadFileSync(fname: string, loc: SourceLoc): Buffer {
        try {
            return readFileSync(fname);
        } catch (err) {
            return this.error(`Couldn't open file '${fname}'`, loc);
        }
    }

    fileInclude (inclStmt: ast.StmtInclude): void {
        const fname = this.makeSourceRelativePath(this.evalExpr(inclStmt.filename));
        this.pushSource(fname);
        this.assemble(fname, inclStmt.loc);
        this.popSource();
    }

    fillBytes (n: ast.StmtFill): void {
        const numVals = this.evalExpr(n.numBytes);
        const fillValue = this.evalExpr(n.fillValue);
        const fv = fillValue;
        if (fv < 0 || fv >= 256) {
            this.error(`!fill value to repeat must be in 8-bit range, '${fv}' given`, fillValue.loc);
        }
        for (let i = 0; i < numVals; i++) {
            this.emit(fv);
        }
    }

    alignBytes (n: ast.StmtAlign): void {
        const nb = this.evalExpr(n.alignBytes);
        if (typeof nb !== 'number') {
            this.error(`Alignment must be a number, ${typeof nb} given`, n.alignBytes.loc);
        }
        if (nb < 1) {
            this.error(`Alignment must be a positive integer, ${nb} given`, n.alignBytes.loc);
        }
        if ((nb & (nb-1)) != 0) {
            this.error(`Alignment must be a power of two, ${nb} given`, n.loc);
        }
        while ((this.codePC & (nb-1)) != 0) {
            this.emit(0);
        }
    }

    withLabelScope (name: string, compileScope: () => void): void {
        this.pushVariableScope();
        this.scopes.pushLabelScope(name);
        compileScope();
        this.scopes.popLabelScope();
        this.popVariableScope();
    }

    withMacroExpandScope (name: string, compileScope: () => void): void {
        this.pushVariableScope();
        this.scopes.pushMacroExpandScope(name);
        compileScope();
        this.scopes.popMacroExpandScope();
        this.popVariableScope();
    }

    emit8or16(v: number, bits: number) {
        if (bits == 8) {
            this.emit(v);
            return;
        }
        this.emit16(v);
    }

    emitData (exprList: ast.Expr[], bits: number) {
        for (let i = 0; i < exprList.length; i++) {
            const e = this.evalExpr(exprList[i]);
            if (typeof e == 'number') {
                this.emit8or16(e, bits);
            } else if (e instanceof Array) {
                // TODO function 'assertType' that returns the value and errors otherwise
                for (let bi in e) {
                    this.emit8or16(e[bi], bits);
                }
            } else {
                this.error(`Only literal (int constants) or array types can be emitted.  Got ${typeof e}`, exprList[i].loc);
            }
        }
    }

    makeFunction (pluginFunc: Function, loc: SourceLoc) {
        return (args: any[]) => {
            const res = pluginFunc({
                readFileSync,
                resolveRelative: (fn: string) => this.makeSourceRelativePath(fn)
            }, ...args);
            return res;
        }
    }

    bindFunction (name: ast.Ident, pluginModule: any, loc: SourceLoc) {
        this.variables.add(name.name, {
            arg: {
                ident: name
            },
            value: this.makeFunction(pluginModule, loc)
        })
}

    bindPlugin (node: ast.StmtLoadPlugin, pluginModule: any) {
        const moduleName = node.moduleName;
        // Bind default export as function
        if (typeof pluginModule == 'function') {
            this.bindFunction(moduleName, pluginModule, node.loc);
        }
        if (typeof pluginModule == 'object') {
            const keys = Object.keys(pluginModule);
            const dstProps = [];
            for (let ki in keys) {
                const key = keys[ki];
                const p = pluginModule[key];
                if (typeof p == 'function') {
                    const funcName = ast.mkIdent(key, node.loc);
                    dstProps.push({
                        key,
                        val: this.makeFunction(p, node.loc),
                        loc: node.loc
                    })
                } else {
                    this.error(`All plugin exported symbols must be functions.  Got ${typeof p} for ${key}`, node.loc)
                }
            }
            this.variables.add(moduleName.name, {
                arg: {
                    ident: moduleName
                },
                value: {
                    type: 'object',
                    props: dstProps,
                    loc: node.loc
                }
            });
        }
    }

    checkDirectives (node: ast.Stmt): void {
        switch (node.type) {
            case 'data': {
                this.emitData(node.values, node.dataSize === ast.DataSize.Byte ? 8 : 16);
                break;
            }
            case 'fill': {
                this.fillBytes(node);
                break;
            }
            case 'align': {
                this.alignBytes(node);
                break;
            }
            case 'setpc': {
                this.setPC(node.pc);
                break;
            }
            case 'binary': {
                this.emitBinary(node);
                break;
            }
            case 'include': {
                this.fileInclude(node);
                break;
            }
            case 'error': {
                this.error(this.evalExpr(node.error), node.loc);
                break;
            }
            case 'if': {
                const { cases, elseBranch } = node
                for (let ci in cases) {
                    const [condExpr, body] = cases[ci];
                    const condition = this.evalExpr(condExpr);
                    if (isTrueVal(condition)) {
                        return this.assembleLines(body);
                    }
                }
                this.assembleLines(elseBranch);
                break;
            }
            case 'for': {
                const { index, list, body, loc } = node
                const lst = this.evalExpr(list);
                if (!(lst instanceof Array)) {
                    this.error(`for-loop range must be an array expression (e.g., a range() or an array)`, list.loc);
                }
                for (let i = 0; i < lst.length; i++) {
                    this.withMacroExpandScope('__forloop', () => {
                        const value = lst[i];
                        const loopVar: Constant = {
                            arg: ast.mkMacroArg(index),
                            value
                        };
                        this.variables.add(index.name, loopVar);
                        return this.assembleLines(body);
                    });
                }
                break;
            }
            case 'macro': {
                const { name, args, body } = node;
                // TODO check for duplicate arg names!
                const prevMacro = this.scopes.findMacro(name.name);
                if (prevMacro !== undefined) {
                    // TODO previous declaration from prevMacro
                    this.error(`Macro '${name.name}' already defined`, name.loc);
                }
                this.scopes.addMacro(name.name, node);
                break;
            }
            case 'callmacro': {
                let argValues: any[] = [];
                const { name, args } = node;
                const macro = this.scopes.findMacro(name.name);

                if (macro == undefined) {
                    this.error(`Undefined macro '${name.name}'`, name.loc);
                    return; // TODO why doesn't this.error never return type work here?
                }

                if (macro.args.length !== args.length) {
                    this.error(`Macro '${name.name}' declared with ${macro.args.length} args but called here with ${args.length}`,
                        name.loc);
                }

                for (let argIdx = 0; argIdx < macro.args.length; argIdx++) {
                    const eres = this.evalExpr(args[argIdx]);
                    argValues.push(eres);
                }
                this.withMacroExpandScope(name.name, () => {
                    for (let argIdx = 0; argIdx < argValues.length; argIdx++) {
                        const argName = macro.args[argIdx].ident;
                        this.variables.add(argName.name, {
                            arg: { ident: argName },
                            value: argValues[argIdx]
                        });
                    }
                    this.assembleLines(macro.body);
                });
                break;
            }
            case 'let': {
                const name = node.name;
                const prevVariable = this.variables.find(name.name);
                if (prevVariable) {
                    return this.error(`Variable '${name.name}' already defined`, node.loc);
                }
                const eres = this.evalExpr(node.value);
                this.variables.add(name.name, {
                    arg: { ident: name },
                    value: eres
                });
                break;
            }
            case 'assign': {
                const name = node.name;
                const prevVariable = this.variables.find(name.name);
                if (prevVariable == undefined) {
                    return this.error(`Assignment to undeclared variable '${name.name}'`, node.loc);
                }
                prevVariable.value = this.evalExpr(node.value);
                break;
            }
            case 'load-plugin': {
                const fname = node.filename;
                const pluginModule = this.requirePlugin(this.evalExpr(fname));
                this.bindPlugin(node, pluginModule);
                break;
            }
            default:
                this.error(`unknown directive ${node.type}`, node.loc);
        }
    }

    assembleLines (lst: ast.AsmLine[]): void {
        if (lst === null) {
            return;
        }
        for (let i = 0; i < lst.length; i++) {
            this.debugInfo.startLine(lst[i].loc, this.codePC);
            this.assembleLine(lst[i]);
            this.debugInfo.endLine(this.codePC);
        }
    }

    assembleLine (line: ast.AsmLine): void {
        // Empty lines are no-ops
        if (line.label == null && line.stmt == null && line.scopedStmts == null) {
            return;
        }

        if (line.label !== null) {
            let lblSymbol = line.label;
            const seenSymbol = this.scopes.findSeenLabel(lblSymbol.name);
            if (seenSymbol) {
                this.error(`Label '${seenSymbol.name}' already defined`, lblSymbol.loc);
                // this.note
                // on line ${lineNo}`)
            } else {
                const labelChanged = this.scopes.declareLabelSymbol(lblSymbol, this.codePC);
                if (labelChanged) {
                    this.needPass = true;
                }
            }
        }

        const scopedStmts = line.scopedStmts;
        if (scopedStmts != null) {
            if (!line.label) {
                throw new Error('ICE: line.label cannot be undefined');
            }
            this.withLabelScope(line.label.name, () => {
                this.assembleLines(scopedStmts);
            });
            return;
        }

        if (line.stmt === null) {
            return;
        }

        if (line.stmt.type !== 'insn') {
            this.checkDirectives(line.stmt);
            return;
        }

        const stmt = line.stmt
        const insn = stmt.insn
        const op = opcodes[insn.mnemonic.toUpperCase()]
        if (op !== undefined) {
            let noArgs =
                insn.imm === null
                && insn.abs === null
                && insn.absx === null
                && insn.absy === null
                && insn.absind === null
            if (noArgs && this.checkSingle(op[10])) {
                return;
            }
            if (this.checkImm(insn.imm, op[0])) {
                return;
            }
            if (this.checkAbs(insn.abs, op[1], 8)) {
                return;
            }

            if (this.checkAbs(insn.absx, op[2], 8)) {
                return;
            }
            if (this.checkAbs(insn.absy, op[3], 8)) {
                return;
            }

            if (this.checkAbs(insn.absx, op[5], 16)) {
                return;
            }
            if (this.checkAbs(insn.absy, op[6], 16)) {
                return;
            }
            // Absolute indirect
            if (this.checkAbs(insn.absind, op[7], 16)) {
                return;
            }

            if (this.checkAbs(insn.indx, op[8], 8)) {
                return;
            }
            if (this.checkAbs(insn.indy, op[9], 8)) {
                return;
            }

            if (this.checkAbs(insn.abs, op[4], 16)) {
                return;
            }
            if (this.checkBranch(insn.abs, op[11])) {
                return;
            }
            this.error(`Couldn't encode instruction '${insn.mnemonic}'`, line.loc);
        } else {
            this.error(`Unknown mnemonic '${insn.mnemonic}'`, line.loc);
        }
    }

    makeSourceRelativePath(filename: string): string {
        const curSource = this.peekSourceStack();
        return path.join(path.dirname(curSource), filename);
    }

    assemble (filename: string, loc: SourceLoc | undefined): void {
        try {
            const astLines = this.parse(filename, loc);
            this.assembleLines(astLines);
        } catch(err) {
            if ('name' in err && err.name == 'SyntaxError') {
                this.addError(`Syntax error: ${err.message}`, {
                    ...err.location,
                    source: this.peekSourceStack()
                })
            } else if ('name' in err && err.name == 'semantic') {
                return;
            } else {
                throw err;
            }
        }
    }

    _requireType(e: any, type: string): (any | never) {
        if (typeof e == type) {
            return e;
        }
        return this.error(`Expecting a ${type} value, got ${typeof e}`, e.loc);
    }

    requireString(e: any): (string | never) { return this._requireType(e, 'string') as string; }
    requireNumber(e: ast.Literal): (number | never) { return this._requireType(e, 'number') as number; }

    registerPlugins () {
        const json = (args: any[]) => {
            const name = this.requireString(args[0]);
            const fname = this.makeSourceRelativePath(name);
            return JSON.parse(readFileSync(fname, 'utf-8'));
        }
        const range = (args: any[]) => {
            let start = 0;
            let end = undefined;
            if (args.length == 1) {
                end = this.requireNumber(args[0]);
            } else if (args.length == 2) {
                start = this.requireNumber(args[0]);
                end = this.requireNumber(args[1]);
            } else {
                throw new Error(`Invalid number of args to 'range'.  Expecting 1 or 2 arguments.`)
            }
            if (end == start) {
                return [];
            }
            if (end < start) {
                throw new Error(`range 'end' must be larger or equal to 'start'`)
            }
            return Array(end-start).fill(null).map((_,idx) => idx + start);
        };
        const addPlugin = (name: string, handler: any) => {
            this.variables.add(name, {
                arg: {
                    ident: ast.mkIdent(name, {} as SourceLoc) // TODO loc?!
                },
                value: handler
            })
        }
        addPlugin('loadJson', json);
        addPlugin('range', range);
    }

    dumpLabels () {
        return this.scopes.dumpLabels(this.codePC);
    }
}

export function assemble(filename: string) {
    const asm = new Assembler();
    asm.pushSource(filename);
    asm.pushVariableScope();
    asm.registerPlugins();

    let pass = 0;
    do {
        asm.pushVariableScope();
        asm.startPass(pass);

        asm.assemble(filename, makeCompileLoc(filename));
        if (asm.anyErrors()) {
            return {
                prg: Buffer.from([]),
                labels: [],
                debugInfo: undefined,
                errors: asm.errors()
            }
        }

        asm.popVariableScope();
        const maxPass = 10;
        if (pass > maxPass) {
            console.error(`Exceeded max pass limit ${maxPass}`);
            return;
        }
        pass += 1;

        if (!asm.needPass && asm.outOfRangeBranches.length != 0) {
            for (let bidx in asm.outOfRangeBranches) {
                const b = asm.outOfRangeBranches[bidx];
                asm.addError(`Branch target too far (must fit in signed 8-bit range, got ${b.offset})`, b.loc);
            }
            break;
        }
    } while(asm.needPass && !asm.anyErrors());

    asm.popVariableScope();
    asm.popSource();

    return {
        prg: asm.prg(),
        errors: asm.errors(),
        labels: asm.dumpLabels(),
        debugInfo: asm.debugInfo
    }
}
