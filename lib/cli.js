//
// Copyright (c) Microsoft and contributors.  All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

// If running from MSI installed version, don't use the
// compile on the fly streamline files. MSI install precompiles
// the streamline files
if (!process.env.PRECOMPILE_STREAMLINE_FILES) {
  require('streamline').register({cache: true});
}

var omelette = require('omelette');

var fs = require('fs');
var path = require('path');
var util = require('util');

var _ = require('underscore');

var ExtendedCommand = require('./util/extendedcommand');
var log = require('./util/logging');

var utils = require('./util/utils');
var Constants = require('./util/constants');
var Interactor = require('./util/interaction');

function AzureCli(name, parent) {
  this.parent = parent;
  this.output = log;
  this.interaction = new Interactor(this);

  if (parent) {
    this._mode = parent._mode;
  }

  AzureCli['super_'].call(this, name);

  if (!parent) {
    this.initSetup();

    this.enableNestedCommands(this);

    // Check node.js version.
    // Do it after changing exception handler.
    this.checkVersion();

    this.harvestPlugins();
    this.harvestModules();

    this.enableAutoComplete();
  }
}

util.inherits(AzureCli, ExtendedCommand);

_.extend(AzureCli.prototype, {
  initSetup: function() {
    var self = this;

    self.debug = process.env.AZURE_DEBUG === '1';

    // Install global unhandled exception handler to make unexpected errors more user-friendly.
    if (!self.debug && process.listeners('uncaughtException').length === 0) {
      self.uncaughExceptionHandler = function (err) {
        self.interaction.clearProgress();

        // Exceptions should always be logged to the console
        var noConsole = false;
        if (!log['default'].transports.console) {
          noConsole = true;
          self.output.add(self.output.transports.Console);
        }

        var loggedFullError = false;
        if (err.message) {
          log.error(err.message);
        } else if (err.Message) {
          log.error(err.Message);
        } else {
          log.json('error', err);
          loggedFullError = true;
        }

        if (!loggedFullError) {
          if (err.stack) {
            log.verbose('stack', err.stack);
          }

          log.json('silly', err);
        }

        self.recordError(err);

        if (noConsole) {
          self.output.remove(self.output.transports.Console);
        }

        self.exit('error', null, 1);
      };

      process.addListener('uncaughtException', self.uncaughExceptionHandler);
    }
  },

  recordError: function(err) {
    if (err && err.stack) {
      try {
        fs.writeFileSync('azure.err', (new Date()) + ':\n' +
            util.inspect(err) + '\n' + err.stack + '\n');
        (log.format().json ? log.error : log.info)('Error information has been recorded to azure.err');
      } catch(err2) {
        log.warn('Cannot save error information :' + util.inspect(err2));
      }
    }
  },

  exit: function (level, message, exitCode) {
    var self = this;

    self.interaction.clearProgress();
    if (message) {
      log.log(level, message);
    }

    if (self.uncaughtExceptionHandler) {
      process.removeListener('uncaughtException', self.uncaughExceptionHandler);
    }

    process.exit(exitCode);
  },

  execute: function (fn) {
    var self = this;

    return self.action(function () {
      self.setupCommandOutput();

      if (log.format().json) {
        log.verbose('Executing command ' + self.fullName().bold);
      } else {
        log.info('Executing command ' + self.fullName().bold);
      }

      try {
        // Expected arguments + options + callback
        var argsCount = fn.length <= 1 ? self.args.length + 2 : fn.length;
        var args = new Array(argsCount);

        var optionIndex = arguments.length - 1;
        for (var i = 0; i < arguments.length; i++) {
          if (typeof arguments[i] === 'object') {
            optionIndex = i;
            break;
          }
        }

        // append with options and callback
        var options = arguments[optionIndex].optionValues;

        args[args.length - 2] = options;
        args[args.length - 1] = callback;

        // set option arguments into their positional respective places
        var freeArguments = 0;
        for(var j = 0; j < self.args.length; j++) {
          var optionName = utils.camelcase(self.args[j].name);
          if (options[optionName]) {
            args[j] = options[optionName];
            delete options[optionName];
          } else if (freeArguments < arguments.length) {
            args[j] = arguments[freeArguments];
            freeArguments++;
          }
        }

        fn.apply(this, args);
      } catch (err) {
        callback(err);
      }

      function callback(err) {
        if (err) {
          // Exceptions should always be logged to the console
          var noConsole = false;
          if (!log['default'].transports.console) {
            noConsole = true;
            self.output.add(self.output.transports.Console);
          }

          if (err.message) {
            log.error(err.message);
            log.json('silly', err);
          } else if (err.Message) {
            if (typeof err.Message === 'object' && typeof err.Message['#'] === 'string') {
              var innerError;
              try {
                innerError = JSON.parse(err.Message['#']);
              } catch (e) {
                // empty
              }

              if (innerError) {
                if (noConsole) {
                  self.output.remove(self.output.transports.Console);
                }

                return callback(innerError);
              }
            }

            log.error(err.Message);
            log.json('verbose', err);
          } else {
            log.error(err);
          }

          self.recordError(err);
          if (err.stack) {
            (self.debug ? log.error : log.verbose)(err.stack);
          }

          if (noConsole) {
            self.output.remove(self.output.transports.Console);
          }

          self.exit('error', self.fullName().bold + ' command ' + 'failed\n'.red.bold, 1);
        } else {
          if (log.format().json) {
            self.exit('verbose', self.fullName().bold + ' command ' + 'OK'.green.bold, 0);
          }
          else {
            self.exit('info', self.fullName().bold + ' command ' + 'OK'.green.bold, 0);
          }
        }
      }
    });
  },

  /*
  * Extends the default parseOptions to support multiple levels in commans parsing.
  */
  parseOptions: function(argv) {
    var args = [];
    var len = argv.length;
    var literal = false;
    var option;
    var arg;

    var unknownOptions = [];

    // parse options
    for (var i = 0; i < len; ++i) {
      arg = argv[i];

      // literal args after --
      if ('--' == arg) {
        literal = true;
        continue;
      }

      if (literal) {
        args.push(arg);
        continue;
      }

      // find matching Option
      option = this.optionFor(arg);

      //// patch begins
      var commandOption = null;

      if (!option && arg[0] === '-') {
        var command = this;
        var arga = null;
        for(var a = 0; a < args.length && command && !commandOption; ++a) {
          arga = args[a];
          if (command.categories && (arga in command.categories)) {
            command = command.categories[arga];
            commandOption = command.optionFor(arg);
            continue;
          }
          break;
        }
        if (!commandOption && arga && command && command.commands) {
          for(var j in command.commands) {
            if (command.commands[j].name === arga) {
              commandOption = command.commands[j].optionFor(arg);
              break;
            }
          }
        }
      }
      //// patch ends

      // option is defined
      if (option) {
        // requires arg
        if (option.required) {
          arg = argv[++i];
          if (!arg) {
            return this.optionMissingArgument(option);
          }

          if ('-' === arg[0]) {
            return this.optionMissingArgument(option, arg);
          }

          this.emit(option.name(), arg);
        } else if (option.optional) {
          // optional arg
          arg = argv[i+1];
          if (!arg || '-' === arg[0]) {
            arg = null;
          } else {
            ++i;
          }

          this.emit(option.name(), arg);
        // bool
        } else {
          this.emit(option.name());
        }
        continue;
      }

      // looks like an option
      if (arg.length > 1 && '-' == arg[0]) {
        unknownOptions.push(arg);

        // If the next argument looks like it might be
        // an argument for this option, we pass it on.
        //// patch: using commandOption if available to detect if the next value is an argument
        // If it isn't, then it'll simply be ignored
        commandOption = commandOption || {optional : 1}; // default assumption
        if (commandOption.required || (commandOption.optional && argv[i+1] && '-' != argv[i+1][0])) {
          unknownOptions.push(argv[++i]);
        }
        continue;
      }

      // arg
      args.push(arg);
    }

    return { args: args, unknown: unknownOptions };
  },

  setupCommand: function(args, raw, topMost) {
    var category = '*';

    for (var i = 0, len = raw.length; i < len; ++i) {
      if (category === '*') {
        category = raw[i];
      } else {
        args.push(raw[i]);
      }
    }

    if (topMost) {
      var opts = {
        json: false,
        level: 'info'
      };

      log.format(opts);
    }

    return category;
  },

  setupCommandOutput: function(raw) {
    var self = this;
    var verbose = 0;
    var json = 0;

    if (!raw) {
      raw = self.normalize(self.parent.rawArgs.slice(2));
    }

    function hasOption(optionName) {
      return self.options.some(function (o) { return o.long === optionName; });
    }

    for (var i = 0, len = raw.length; i < len; ++i) {
      if (hasOption('--json') &&
        raw[i] === '--json') {
        ++json;
      } else if (hasOption('--verbose') &&
        (raw[i] === '-v' || raw[i] === '--verbose')) {
        ++verbose;
      }
    }

    var opts = { };
    if (verbose || json) {
      if (json) {
        opts.json = true;
        opts.level = 'data';
      }

      if (verbose == 1) {
        opts.json = false;
        opts.level = 'verbose';
      }

      if (verbose >= 2) {
        opts.json = false;
        opts.level = 'silly';
      }

      log.format(opts);
    }
  },

  enableAutoComplete: function() {
    var root = this;

    root.autoComplete = omelette('azure');

    function handleAutocomplete(fragment, word, line) {
      var results;

      var args = line.trim().split(' ').filter(function (a) {
        return a !== '';
      });

      args.shift(); // discard "azure" word

      var currentCategory = root;
      while (currentCategory) {
        /*jshint loopfunc:true*/
        if (args.length === 0) {
          return this.reply(Object.keys(currentCategory.categories).concat(
            currentCategory.commands.map(function (c) { return c.name; })
          ));
        } else {
          var currentWord = args.shift().trim();

          if (currentCategory.categories[currentWord]) {
            currentCategory = currentCategory.categories[currentWord];
          } else if (args.length === 0) {
            var command = currentCategory.commands.filter(function (c) {
              return c.name === currentWord;
            })[0];

            if (command) {
              return this.reply(command.options.map(function (o) { return o.long; }));
            } else {
              results = currentCategory.commands.filter(function (c) {
                return currentWord !== c.name && utils.stringStartsWith(c.name, currentWord);
              }).map(function (c) {
                return c.name;
              });

              results = results.concat(Object.keys(currentCategory.categories).filter(function (c) {
                return currentWord !== c && utils.stringStartsWith(c, currentWord);
              }));

              return this.reply(results);
            }
          } else {
            return this.reply([]);
          }
        }
      }

      return this.reply([]);
    }

    root.autoComplete.on('complete', handleAutocomplete);
    root.autoComplete.init();
  },

  enableNestedCommands: function(command) {
    if (!command.parent) {
      command.option('-v, --version', 'output the application version');
    }

    command.categories = {};

    command.category = function (name) {
      var category = command.categories[name];
      if (!command.categories[name]) {
        category = command.categories[name] = new AzureCli(name, this);
        category.helpInformation = command.categoryHelpInformation;
        command.enableNestedCommands(category);
      }

      return category;
    };

    command.on('*', function () {
      var args = command.rawArgs.slice(0, 2);
      var raw = command.normalize(command.rawArgs.slice(2));

      var category = command.setupCommand(args, raw, command.parent === undefined);

      var cat = command.categories[category];
      if (!cat) {
        log.error('\'' + category + '\' is not an azure command. See \'azure help\'.');
      } else {
        cat.parse(args);
        if (cat.args.length === 0) {
          args.push('-h');
          cat.parse(args);
        }
      }
    });
  },

  command: function (name) {
    var args = name.split(/ +/);
    var cmd = new AzureCli(args.shift(), this);
    cmd.option('-v, --verbose', 'use verbose output');
    cmd.option('--json', 'use json output');

    cmd.helpInformation = cmd.commandHelpInformation;
    this.commands.push(cmd);
    cmd.parseExpectedArgs(args);
    return cmd;
  },

  deprecatedDescription: function (text, newCommand) {
    return this.description(util.format('%s (deprecated. This command is deprecated and will be removed in a future version. Please use \"%s\" instead', text, newCommand));
  },

  detailedDescription: function (str) {
    if (0 === arguments.length) return this._detailedDescription;
    this._detailedDescription = str;
    return this;
  },

  harvestPlugins: function() {
    var self = this;

    function scan(scanPath, recursively) {
      var results = utils.getFiles(scanPath, recursively);

      results = results.filter(function (filePath) {
        var extname = path.extname(filePath);
        if (filePath.substring(0, 5) === 'tmp--') {
          return false;
        } else if (extname !== '.js' && extname !== '._js') {
          //Skip unrelated/temp files
          return false;
        }
        return true;
      });

      if (process.env.PRECOMPILE_STREAMLINE_FILES) {
        results = results.filter(function (filePath) {
          if (filePath.substring(filePath.length - 4) === '._js') {
            return false;
          }
          return true;
        });
      }

      // sort them so they load in a predictable order
      results = results.sort();

      // skip directories
      results = results.filter(function (filePath) {
        return fs.statSync(filePath).isFile();
      });

      // load modules
      results = results.map(function (filePath) {
        return require(filePath);
      });

      // look for exports.init
      results = results.filter(function (entry) {
        return entry.init !== undefined;
      });
      return results;
    }

    var basePath = path.dirname(__filename);

    var plugins = scan(path.join(basePath, 'commands'), false);
    plugins.forEach(function (plugin) { plugin.init(self); });

    // Load mode plugins
    var modePlugins = scan(path.join(basePath, 'commands', self.getMode()), true);
    modePlugins.forEach(function (plugin) { plugin.init(self); });
  },

  getMode: function () {
    var config = utils.readConfig();
    if (config.mode) {
      var basePath = path.dirname(__filename);
      var modeDirectory = path.join(basePath, 'commands', config.mode);

      if (fs.existsSync(modeDirectory)) {
        return config.mode;
      } else {
        log.error(util.format('Invalid config mode %s. Reseting to %s.', config.mode, Constants.API_VERSIONS.ASM));
        delete config.mode;
        utils.writeConfig(config);
      }
    }

    return Constants.API_VERSIONS.ASM;
  },

  harvestModules: function() {
    var self = this;

    var basePath = path.dirname(__filename);

    var walkPath = path.join(basePath, '../node_modules');
    var harvestPaths = [walkPath];

    while (path.basename(walkPath) === 'node_modules' && path.dirname(walkPath) !== 'npm') {
      var nextPath = path.join(walkPath, '../..');
      if (nextPath === walkPath) {
        break;
      }
      harvestPaths.push(nextPath);
      walkPath = nextPath;
    }

    var modules = [];
    harvestPaths.forEach(function (harvestPath) {
      modules = modules.concat(scan(harvestPath));
    });

    modules.forEach(function (module) {
      module.plugin.init(self);
    });

    function scan(scanPath) {
      var results = fs.readdirSync(scanPath);

      results = results.map(function (moduleName) {
        return {
          moduleName: moduleName,
          modulePath: path.join(scanPath, moduleName)
        };
      });

      results = results.filter(function (item) {
        try {
          item.moduleStat = fs.statSync(item.modulePath);
        } catch(error) {
          return false;
        }
        return item.moduleStat.isDirectory();
      });

      results = results.filter(function (item) {
        item.packagePath = path.join(item.modulePath, 'package.json');
        item.packageStat = utils.pathExistsSync(item.packagePath) ? fs.statSync(item.packagePath) : undefined;
        return item.packageStat && item.packageStat.isFile();
      });

      results = results.filter(function (item) {
        try {
          item.packageInfo = JSON.parse(fs.readFileSync(item.packagePath));
          return item.packageInfo && item.packageInfo.plugins && item.packageInfo.plugins['azure-cli'];
        }
        catch (err) {
          return false;
        }
      });

      results = flatten(results.map(function (item) {
        var plugins = item.packageInfo.plugins['azure-cli'];
        if (!_.isArray(plugins)) {
          plugins = [plugins];
        }

        return plugins.map(function (relativePath) {
          return {
            context: item,
            pluginPath: path.join(item.modulePath, relativePath)
          };
        });
      }));

      results = results.filter(function (item) {
        item.plugin = require(item.pluginPath);
        return item.plugin.init;
      });

      return results;
    }

    function flatten(arrays) {
      var result = [];
      arrays.forEach(function (array) {
        result = result.concat(array);
      });
      return result;
    }
  },

  checkVersion: function() {
    // Uploading VHD needs 0.6.15 on Windows
    var version = process.version;
    var ver = version.split('.');
    var ver1num = parseInt(ver[1], 10);
    var ver2num = parseInt(ver[2], 10);
    if (ver[0] === 'v0') {
      if (ver1num < 6 || (ver1num === 6 && ver2num < 15)) {
        throw new Error('You need node.js v0.6.15 or higher to run this code. Your version: ' +
            version);
      }
      if (ver1num === 7 && ver2num <= 7) {
        throw new Error('You need node.js v0.6.15 or higher to run this code. Your version ' +
            version + ' won\'t work either.');
      }
    }
  }
});

exports = module.exports = AzureCli;
