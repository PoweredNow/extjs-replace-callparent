export default function ({ types: t }) {

    function isThisOrMeExpression(node) {
        return t.isThisExpression(node) || t.isIdentifier(node, { name: 'me' });
    }

    function isCallParentCallee(node) {
        return t.isMemberExpression(node) &&
            isThisOrMeExpression(node.object) &&
            t.isIdentifier(node.property, { name: 'callParent' });
    }

    function isExtDefineCall(extNames) {
        extNames = extNames || ['Ext'];
        return function (path) {
            if (!path.isCallExpression()) {
                return false;
            }
            let callee = path.node.callee;
            return t.isMemberExpression(callee) &&
                t.isIdentifier(callee.object) && extNames.includes(callee.object.name) &&
                t.isIdentifier(callee.property, { name: 'define' });
        };
    }

    function getProtoPropFromObjectExpression(objectExpression) {
        return objectExpression.properties.find((prop) => {
            return t.isIdentifier(prop.key) && (prop.key.name === 'extend' || prop.key.name === 'override');
        });
    }

    const returnStatementVisitor = {
        ReturnStatement(path) {
            if (!path.findParent((p) => p.isFunctionExpression()) === this.functionExpression) {
                return;
            }
            path.stop(); // we've found the return statement, stop traversal
            let returnArg = path.get('argument');
            if (!returnArg.isObjectExpression()) {
                return;
            }
            this.returnArg = returnArg.node;
        }
    };

    function getFunctionDefineReturnObjectExpression(functionExpression) {
        let nestedVisitorState = { functionExpression, returnArg: null };
        functionExpression.traverse(returnStatementVisitor, nestedVisitorState);
        return nestedVisitorState.returnArg;
    }

    function getProtoProp(defineCall) {
        const bodyArg = defineCall.get('arguments.1');
        if (bodyArg.isObjectExpression()) {
            return getProtoPropFromObjectExpression(bodyArg.node);
        } else if (bodyArg.isFunctionExpression()) {
            let objectExpression = getFunctionDefineReturnObjectExpression(bodyArg);
            if (!objectExpression) {
                return;
            }
            return getProtoPropFromObjectExpression(objectExpression);
        }
    }

    function getOverrideMethodRef(methodRef, defineCall) {
        const methodRefVar = defineCall.scope.generateUidIdentifier('o');
        defineCall.insertBefore(
            t.variableDeclaration(
                'var',
                [
                    t.variableDeclarator(
                        methodRefVar,
                        methodRef
                    )
                ]
            )
        );
        return methodRefVar;
    }

    function isClassMethod(path) {
        return path.isObjectProperty() &&
            t.isFunction(path.node.value);
    }

    function buildMemberExpression(stringRef) {
        return stringRef.split('.').reduce((last, next) => {
            return last ? t.memberExpression(last, t.identifier(next)) : t.identifier(next);
        }, null);
    }

    function buildMethodRef(protoRef, methodName) {
        const calleeExpression = t.memberExpression(
            t.identifier('arguments'),
            t.identifier('callee')
        );
        const superclassExpression = t.memberExpression(
            t.identifier('$owner'),
            t.identifier('superclass')
        );
        /** arguments.callee.$previous */
        const builtPrevious = t.memberExpression(
            calleeExpression,
            t.identifier('$previous')
        )
        const calleeName = t.memberExpression(
            calleeExpression,
            t.identifier('$name')
        )
        const builtSuperclass = t.memberExpression(
            t.memberExpression(
                calleeExpression,
                t.identifier('$owner')
            ),
            t.identifier('superclass'),
        );
        const builtSuperclassCaller = t.logicalExpression('&&', t.memberExpression(
            calleeExpression,
            t.identifier('$owner')
        ), t.memberExpression(
            builtSuperclass,
            calleeName,
            true,
        ));

        return t.logicalExpression('||', t.logicalExpression('||', builtPrevious, builtSuperclassCaller), t.memberExpression(t.logicalExpression('||', t.memberExpression(protoRef, t.identifier('prototype')), protoRef), t.identifier(methodName)));
    }

    function buildOverridenMethodRef(protoRef, methodName) {
        return t.memberExpression(
            t.memberExpression(t.logicalExpression(
                '||',
                t.memberExpression(protoRef, t.identifier('prototype')),
                protoRef
            ), t.identifier(methodName)),
            t.identifier('$previous'));
    }

    function buildReplacement(methodRef, args) {
        const memberExpression = t.memberExpression(methodRef, t.identifier(args.length ? 'apply' : 'call'));
        return args.length ? t.callExpression(memberExpression, [t.thisExpression(), args[0]]) :
            t.callExpression(memberExpression, [t.thisExpression()]);
    }

    function getProtoRef(protoProp) {
        if (!protoProp) {
            return buildMemberExpression('Ext.Base');
        }
        return t.isStringLiteral(protoProp.value) ? buildMemberExpression(protoProp.value.value) : protoProp.value;
    }

    return {
        visitor: {
            CallExpression(path, state) {
                if (!isCallParentCallee(path.node.callee)) {
                    return;
                }
                const defineCall = path.findParent(isExtDefineCall(state.opts.extNames));
                if (!defineCall) {
                    console.warn("Unable to find 'Ext.define' for this 'callParent'");
                    return;
                }

                const clsMethod = path.findParent(isClassMethod);
                if (!clsMethod) {
                    throw path.buildCodeFrameError("Unable to find method declaration for this 'callParent'");
                }
                const unsupportedMethods = ['apply', 'get', 'set', 'update', 'constructor'];
                const isMethodUnsupported = unsupportedMethods.some(method => clsMethod.node.key.name.indexOf(method) === 0);
                const isAsyncFunction = clsMethod && clsMethod.node.value.async;
                if (isAsyncFunction && isMethodUnsupported) {
                    throw path.buildCodeFrameError("callParent is not supported in async fuctions of the following types: " + unsupportedMethods.join(', '));
                }
                const methodName = clsMethod.node.key.name;

                const protoProp = getProtoProp(defineCall);
                const isOverride = protoProp && protoProp.key.name === 'override';
                const protoRef = getProtoRef(protoProp);
                let methodRef = buildMethodRef(protoRef, methodName);
                if (isOverride) {
                    methodRef = buildOverridenMethodRef(protoRef, methodName);
                }

                const args = path.node.arguments;
                if (isAsyncFunction && !isMethodUnsupported) {
                    path.replaceWith(buildReplacement(methodRef, args));
                }
            }
        }
    };
};

