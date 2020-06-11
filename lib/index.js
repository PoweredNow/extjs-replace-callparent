'use strict';

Object.defineProperty(exports, "__esModule", {
    value: true
});

exports.default = function (_ref) {
    var t = _ref.types;


    function isThisOrMeExpression(node) {
        return t.isThisExpression(node) || t.isIdentifier(node, { name: 'me' });
    }

    function isCallParentCallee(node) {
        return t.isMemberExpression(node) && isThisOrMeExpression(node.object) && t.isIdentifier(node.property, { name: 'callParent' });
    }

    function isExtDefineCall(extNames) {
        extNames = extNames || ['Ext'];
        return function (path) {
            if (!path.isCallExpression()) {
                return false;
            }
            var callee = path.node.callee;
            return t.isMemberExpression(callee) && t.isIdentifier(callee.object) && extNames.includes(callee.object.name) && t.isIdentifier(callee.property, { name: 'define' });
        };
    }

    function getProtoPropFromObjectExpression(objectExpression) {
        return objectExpression.properties.find(function (prop) {
            return t.isIdentifier(prop.key) && (prop.key.name === 'extend' || prop.key.name === 'override');
        });
    }

    var returnStatementVisitor = {
        ReturnStatement: function ReturnStatement(path) {
            if (!path.findParent(function (p) {
                return p.isFunctionExpression();
            }) === this.functionExpression) {
                return;
            }
            path.stop(); // we've found the return statement, stop traversal
            var returnArg = path.get('argument');
            if (!returnArg.isObjectExpression()) {
                return;
            }
            this.returnArg = returnArg.node;
        }
    };

    function getFunctionDefineReturnObjectExpression(functionExpression) {
        var nestedVisitorState = { functionExpression: functionExpression, returnArg: null };
        functionExpression.traverse(returnStatementVisitor, nestedVisitorState);
        return nestedVisitorState.returnArg;
    }

    function getProtoProp(defineCall) {
        var bodyArg = defineCall.get('arguments.1');
        if (bodyArg.isObjectExpression()) {
            return getProtoPropFromObjectExpression(bodyArg.node);
        } else if (bodyArg.isFunctionExpression()) {
            var objectExpression = getFunctionDefineReturnObjectExpression(bodyArg);
            if (!objectExpression) {
                return;
            }
            return getProtoPropFromObjectExpression(objectExpression);
        }
    }

    function getOverrideMethodRef(methodRef, defineCall) {
        var methodRefVar = defineCall.scope.generateUidIdentifier('o');
        defineCall.insertBefore(t.variableDeclaration('var', [t.variableDeclarator(methodRefVar, methodRef)]));
        return methodRefVar;
    }

    function isClassMethod(path) {
        return path.isObjectProperty() && t.isFunction(path.node.value);
    }

    function buildMemberExpression(stringRef) {
        return stringRef.split('.').reduce(function (last, next) {
            return last ? t.memberExpression(last, t.identifier(next)) : t.identifier(next);
        }, null);
    }

    function buildMethodRef(protoRef, methodName) {
        var calleeExpression = t.memberExpression(t.identifier('arguments'), t.identifier('callee'));
        var superclassExpression = t.memberExpression(t.identifier('$owner'), t.identifier('superclass'));
        /** arguments.callee.$previous */
        var builtPrevious = t.memberExpression(calleeExpression, t.identifier('$previous'));
        var calleeName = t.memberExpression(calleeExpression, t.identifier('$name'));
        var builtSuperclass = t.memberExpression(t.memberExpression(calleeExpression, t.identifier('$owner')), t.identifier('superclass'));
        var builtSuperclassCaller = t.logicalExpression('&&', t.memberExpression(calleeExpression, t.identifier('$owner')), t.memberExpression(builtSuperclass, calleeName, true));

        return t.logicalExpression('||', t.logicalExpression('||', builtPrevious, builtSuperclassCaller), t.memberExpression(t.logicalExpression('||', t.memberExpression(protoRef, t.identifier('prototype')), protoRef), t.identifier(methodName)));
    }

    function buildOverridenMethodRef(protoRef, methodName) {
        return t.memberExpression(t.memberExpression(t.logicalExpression('||', t.memberExpression(protoRef, t.identifier('prototype')), protoRef), t.identifier(methodName)), t.identifier('$previous'));
    }

    function buildReplacement(methodRef, args) {
        var memberExpression = t.memberExpression(methodRef, t.identifier(args.length ? 'apply' : 'call'));
        return args.length ? t.callExpression(memberExpression, [t.thisExpression(), args[0]]) : t.callExpression(memberExpression, [t.thisExpression()]);
    }

    function getProtoRef(protoProp) {
        if (!protoProp) {
            return buildMemberExpression('Ext.Base');
        }
        return t.isStringLiteral(protoProp.value) ? buildMemberExpression(protoProp.value.value) : protoProp.value;
    }

    return {
        visitor: {
            CallExpression: function CallExpression(path, state) {
                if (!isCallParentCallee(path.node.callee)) {
                    return;
                }
                var defineCall = path.findParent(isExtDefineCall(state.opts.extNames));
                if (!defineCall) {
                    console.warn("Unable to find 'Ext.define' for this 'callParent'");
                    return;
                }

                var clsMethod = path.findParent(isClassMethod);
                if (!clsMethod) {
                    throw path.buildCodeFrameError("Unable to find method declaration for this 'callParent'");
                }
                var unsupportedMethods = ['apply', 'get', 'set', 'update', 'constructor'];
                var isMethodUnsupported = unsupportedMethods.some(function (method) {
                    return clsMethod.node.key.name.indexOf(method) === 0;
                });
                var isAsyncFunction = clsMethod && clsMethod.node.value.async;
                if (isAsyncFunction && isMethodUnsupported) {
                    throw path.buildCodeFrameError("callParent is not supported in async fuctions of the following types: " + unsupportedMethods.join(', '));
                }
                var methodName = clsMethod.node.key.name;

                var protoProp = getProtoProp(defineCall);
                var isOverride = protoProp && protoProp.key.name === 'override';
                var protoRef = getProtoRef(protoProp);
                var methodRef = buildMethodRef(protoRef, methodName);
                if (isOverride) {
                    methodRef = buildOverridenMethodRef(protoRef, methodName);
                }

                var args = path.node.arguments;
                if (isAsyncFunction && !isMethodUnsupported) {
                    path.replaceWith(buildReplacement(methodRef, args));
                }
            }
        }
    };
};

;