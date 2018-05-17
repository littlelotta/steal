addStealExtension(function applyTraceExtension(loader) {
	if(loader._extensions) {
		loader._extensions.push(applyTraceExtension);
	}

	loader._traceData = {
		loads: {},
		parentMap: {}
	};

	loader.getDependencies = function(moduleName){
		var load = this.getModuleLoad(moduleName);
		return load ? load.metadata.dependencies : undefined;
	};
	loader.getDependants = function(moduleName){
		var deps = [];
		var pars = this._traceData.parentMap[moduleName] || {};
		eachOf(pars, function(name) { deps.push(name); });
		return deps;
	};
	loader.getModuleLoad = function(moduleName){
		return this._traceData.loads[moduleName];
	};
	loader.getBundles = function(moduleName, argVisited){
		var visited = argVisited || {};
		visited[moduleName] = true;
		var loader = this;
		var parentMap = loader._traceData.parentMap;
		var parents = parentMap[moduleName];
		if(!parents) return [moduleName];

		var bundles = [];
		eachOf(parents, function(parentName, value){
			if(!visited[parentName])
				bundles = bundles.concat(loader.getBundles(parentName, visited));
		});
		return bundles;
	};
	loader.getImportSpecifier = function(fullModuleName, load){
		var idx = 0, specifier;
		while(idx < load.metadata.dependencies.length) {
			if(load.metadata.dependencies[idx] === fullModuleName) {
				specifier = load.metadata.deps[idx];
				break;
			}
			idx++;
		}
		if(specifier) {
			if(load.metadata.importSpecifiers) {
				return (load.metadata.importSpecifiers[specifier] || {}).start;
			} else if(load.metadata.getImportPosition) {
				return load.metadata.getImportPosition(specifier);
			}
		}
	};
	loader.moduleSpecifierFromName = function(load, moduleName) {
		var idx = load.metadata.dependencies.indexOf(moduleName);
		return load.metadata.deps[idx];
	};
	loader._allowModuleExecution = {};
	loader.allowModuleExecution = function(name){
		var loader = this;
		return loader.normalize(name).then(function(name){
			loader._allowModuleExecution[name] = true;
		});
	};

	function eachOf(obj, callback){
		var name;
		for(name in obj) {
			callback(name, obj[name]);
		}
	}

	var normalize = loader.normalize;
	loader.normalize = function(name, parentName){
		var normalizePromise = normalize.apply(this, arguments);

		if(parentName) {
			var parentMap = this._traceData.parentMap;
			return normalizePromise.then(function(name){
				if(!parentMap[name]) {
					parentMap[name] = {};
				}
				parentMap[name][parentName] = true;
				return name;
			});
		}

		return normalizePromise;
	};

	var emptyExecute = function(){
		return loader.newModule({});
	};

	var passThroughModules = {
		traceur: true,
		babel: true
	};
	var isAllowedToExecute = function(load){
		return passThroughModules[load.name] || this._allowModuleExecution[load.name];
	};

	var map = [].map || function(callback){
		var res = [];
		for(var i = 0, len = this.length; i < len; i++) {
			res.push(callback(this[i]));
		}
		return res;
	};

	var esImportDepsExp = /import [\s\S]*?["'](.+)["']/g;
	var esExportDepsExp = /export .+ from ["'](.+)["']/g;
	var commentRegEx = /(?:(?:^|\s)\/\/(.+?)$)|(?:\/\*([\S\s]*?)\*\/)/gm;
	var stringRegEx = /(?:("|')[^\1\\\n\r]*(?:\\.[^\1\\\n\r]*)*\1|`[^`]*`)/g;

	function getESDeps(source) {
		var cleanSource = source.replace(commentRegEx, "");

		esImportDepsExp.lastIndex = commentRegEx.lastIndex =
			esExportDepsExp.lastIndex = stringRegEx.lastIndex = 0;

		var match;
		var deps = [];
		var stringLocations = []; // track string for unminified source

		function inLocation(locations, match) {
		  for (var i = 0; i < locations.length; i++)
			if (locations[i][0] < match.index && locations[i][1] > match.index)
			  return true;
		  return false;
		}

		function addDeps(exp) {
			while (match = exp.exec(cleanSource)) {
			  // ensure we're not within a string location
			  if (!inLocation(stringLocations, match)) {
				var dep = match[1];
				deps.push(dep);
			  }
			}
		}

		if (source.length / source.split('\n').length < 200) {
		  while (match = stringRegEx.exec(cleanSource))
			stringLocations.push([match.index, match.index + match[0].length]);
		}

		addDeps(esImportDepsExp);
		addDeps(esExportDepsExp);

		return deps;
	}

	function isESModule(instantiateResult) {
		return !instantiateResult;
	}

	var instantiate = loader.instantiate;
	loader.instantiate = function(load){
		this._traceData.loads[load.name] = load;
		var loader = this;
		var instantiatePromise = Promise.resolve(instantiate.apply(this, arguments));

		var preventExecution =
			loader.preventModuleExecution && !isAllowedToExecute.call(loader, load);

		function finalizeResult(result){
			// deps either comes from the instantiate result, or if an
			// es6 module it was found in the transpile hook.
			var deps = result ? result.deps : load.metadata.deps;

			return Promise.all(map.call(deps, function(depName){
				return loader.normalize(depName, load.name);
			})).then(function(dependencies){
				load.metadata.deps = deps;
				load.metadata.dependencies = dependencies;

				if(preventExecution) {
					return {
						deps: deps,
						execute: emptyExecute
					};
				}

				return result;

			});
		}

		return instantiatePromise
			.then(function(result) {
				// run the treeshake plugin on ES modules during build phase
				if (
					isESModule(result) &&
					preventExecution &&
					loader.treeshaker &&
					loader.transpiler === "babel"
				) {
					return loader.treeshaker.applyBabelPlugin(load)
						.then(function(source) {
							load.source = source;
							return result;
						});
				}
				return result;
			})
			.then(function(result) {
				if (isESModule(result)) {
					var deps = getESDeps(load.source);
					load.metadata.deps = deps;
				}
				return finalizeResult(result);
			});
	};

	var transpile = loader.transpile;
	// Allow transpile to be memoized, but only once
	loader.transpile = function(load){
		var transpiled = load.metadata.transpiledSource;
		if(transpiled) {
			delete load.metadata.transpiledSource;
			return Promise.resolve(transpiled);
		}
		return transpile.apply(this, arguments);
	};

	loader.eachModule = function(cb){
		for (var moduleName in this._loader.modules) {
			cb.call(this, moduleName, this.get(moduleName));
		}
	};
});
