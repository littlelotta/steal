addStealExtension(function(loader) {
	function determineUsedExports(load) {
		var loader = this;

		// 1. Get any new dependencies that haven't been accounted for.
		var newDeps = newDependants.call(this, load);
		var usedExports = new loader.Set();
		var allUsed = false;
		newDeps.forEach(function(depName) {
			var depLoad = loader.getModuleLoad(depName);
			var specifier = loader.moduleSpecifierFromName(depLoad, load.name);
			if (depLoad.metadata.format !== "es6") {
				allUsed = true;
				return;
			}

			var usedNames = depLoad.metadata.importNames[specifier] || [];
			usedNames.forEach(function(name) {
				usedExports.add(name);
			});
		});

		// 2. Remove unused exports by traversing the AST
		load.metadata.usedExports = usedExports;
		load.metadata.allExportsUsed = allUsed;

		return {
			all: allUsed,
			used: usedExports
		};
	}

	// Determine if this load's dependants have changed,
	function newDependants(load) {
		var out = [];
		var deps = this.getDependants(load.name);
		var shakenParents = load.metadata.shakenParents;
		if (!shakenParents) {
			out = deps;
		} else {
			for (var i = 0; i < deps.length; i++) {
				if (shakenParents.indexOf(deps[i]) === -1) {
					out.push(deps[i]);
				}
			}
		}
		return out;
	}

	/**
	 * Look at a parent (dependant) module and get which exports it uses for a load.
	 */
	function getUsedExportsFromParent(load, parentName) {
		var parentLoad = this.getModuleLoad(parentName);
		var parentImportNames = parentLoad.metadata.importNames;
		if (parentImportNames) {
			var parentSpecifier = this.moduleSpecifierFromName(
				parentLoad,
				load.name
			);
			var usedNames = parentImportNames[parentSpecifier];
			return usedNames || [];
		}
		return [];
	}

	/**
	 * Determine if the new parent has resulted in new used export names
	 * If so, redefine this module so that it goes into the registry correctly.
	 */
	function reexecuteIfNecessary(load, parentName) {
		var usedExports = getUsedExportsFromParent.call(this, load, parentName);

		// Given the parent's used exports, loop over and see if any are not
		// within the usedExports set.
		var hasNewExports = false;
		for (var i = 0; i < usedExports.length; i++) {
			if (!load.metadata.usedExports.has(usedExports[i])) {
				hasNewExports = true;
			}
		}

		if (hasNewExports) {
			this["delete"](load.name);
			return loader.define(load.name, load.source, load);
		}

		return Promise.resolve();
	}

	// Wrap normalize to check if a module has already been tree-shaken
	// And if so, re-execute it if there are new dependant modules.
	var normalize = loader.normalize;
	loader.normalize = function(name, parentName) {
		var loader = this;
		var p = Promise.resolve(normalize.apply(this, arguments));

		return p.then(function(name) {
			var load = loader.getModuleLoad(name);

			// If this module is already marked as tree-shakable it means
			// it has been loaded before. Determine if it needs to be reexecuted.
			if (load && load.metadata.treeShakable) {
				return reexecuteIfNecessary
					.call(loader, load, parentName)
					.then(function() {
						return name;
					});
			}
			return name;
		});
	};

	function getImportSpecifierPositionsPlugin(load) {
		load.metadata.importSpecifiers = Object.create(null);
		load.metadata.importNames = Object.create(null);

		return {
			visitor: {
				ImportDeclaration: function(path, state) {
					var node = path.node;
					var specifier = node.source.value;
					var loc = node.source.loc;
					load.metadata.importSpecifiers[specifier] = loc;
					load.metadata.importNames[specifier] = (
						node.specifiers || []
					).map(function(spec) {
						return spec.imported && spec.imported.name;
					});
				}
			}
		};
	}

	function treeShakePlugin(loader, load) {
		var notShakable = {
			exit: function(path, state) {
				state.treeShakable = false;
			}
		};

		var notShakeableVisitors = {
			ImportDeclaration: notShakable,
			FunctionDeclaration: notShakable,
			VariableDeclaration: notShakable
		};

		return {
			visitor: {
				Program: {
					enter: function(path) {
						var state = {};
						path.traverse(notShakeableVisitors, state);
						load.metadata.treeShakable =
							state.treeShakable !== false;
					}
				},

				ExportNamedDeclaration: function(path, state) {
					if (load.metadata.treeShakable) {
						var usedResult = determineUsedExports.call(
							loader,
							load
						);

						var usedExports = usedResult.used;
						var allUsed = usedResult.all;

						if (!allUsed) {
							path.get("specifiers").forEach(function(path) {
								var name = path.get("exported.name").node;
								if (
									!usedExports.has(name) &&
									name !== "__esModule"
								) {
									path.remove();
								}
							});

							if (path.get("specifiers").length === 0) {
								path.remove();
							}
						}
					}
				}
			}
		};
	}

	// Make treeshaker available on the loader so it can be used in other
	// places within steal, like the transpiler module used in the loader itself
	loader.treeshaker = {
		applyBabelPlugin: function applyBabelPlugin(load) {
			return loader.import("babel").then(function(mod) {
				var transpiler = mod.__useDefault ? mod.default : mod;
				var babel = transpiler.Babel || transpiler.babel || transpiler;

				try {
					return babel.transform(load.source, {
						plugins: [
							getImportSpecifierPositionsPlugin.bind(null, load),
							treeShakePlugin.bind(null, loader, load)
						]
					}).code;
				} catch (e) {
					return Promise.reject(e);
				}
			});
		},
		babelPlugin: treeShakePlugin
	};
});
