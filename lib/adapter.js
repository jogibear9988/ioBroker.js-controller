/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';

// This is file, that makes all communication with controller. All options are optional except name.
// following options are available:
//   name:          name of the adapter. Must be exactly the same as directory name.
//   dirname:       adapter directory name
//   instance:      instance number of adapter
//   objects:       true or false, if desired to have oObjects. This is a list with all states, channels and devices of this adapter and it will be updated automatically.
//   states:        true or false, if desired to have oStates. This is a list with all states values and it will be updated automatically.
//   systemConfig:  if required system configuration. Store it in systemConfig attribute
//   objectChange:  callback function (id, obj) that will be called if object changed
//   stateChange:   callback function (id, obj) that will be called if state changed
//   message:       callback to inform about new message the adapter
//   unload:        callback to stop the adapter
//   config:        configuration of the connection to controller
//   noNamespace:   return short names of objects and states in objectChange and in stateChange

const net               = require('net');
const fs                = require('fs');
const extend            = require('node.extend');
const util              = require('util');
const os                = require('os');
const EventEmitter      = require('events').EventEmitter;
const tools             = require('./tools');
const pidUsage          = require('pidusage');
const getConfigFileName = tools.getConfigFileName;
const EXIT_CODES        = require('./exitCodes');

const password          = require('./password');
/** @type {Record<string, any>} */
let config              = null;
let defaultObjs;
const FORBIDDEN_CHARS   =   /[\]\[*,;'"`<>\\?]/g;
const DEFAULT_SECRET    = 'Zgfr56gFe87jJOM';
const ALIAS_STARTS_WITH = 'alias.';
let schedule;
let restartScheduleJob;

const supportedFeatures = [
    'ALIAS', // Alias Feature supported
    'ADAPTER_GETPORT_BIND' // getPort method of adapter supports second parameter to bind to a special network interface
];

//const ACCESS_EVERY_EXEC  = 0x1;
const ACCESS_EVERY_WRITE = 0x2;
const ACCESS_EVERY_READ  = 0x4;
//const ACCESS_EVERY_RW    = ACCESS_EVERY_WRITE | ACCESS_EVERY_READ;
//const ACCESS_EVERY_ALL   = ACCESS_EVERY_WRITE | ACCESS_EVERY_READ | ACCESS_EVERY_EXEC;

//const ACCESS_GROUP_EXEC  = 0x10;
const ACCESS_GROUP_WRITE = 0x20;
const ACCESS_GROUP_READ  = 0x40;
//const ACCESS_GROUP_RW    = ACCESS_GROUP_WRITE | ACCESS_GROUP_READ;
//const ACCESS_GROUP_ALL   = ACCESS_GROUP_WRITE | ACCESS_GROUP_READ | ACCESS_GROUP_EXEC;

//const ACCESS_USER_EXEC   = 0x100;
const ACCESS_USER_WRITE  = 0x200;
const ACCESS_USER_READ   = 0x400;
//const ACCESS_USER_RW     = ACCESS_USER_WRITE | ACCESS_USER_READ;
//const ACCESS_USER_ALL    = ACCESS_USER_WRITE | ACCESS_USER_READ | ACCESS_USER_EXEC;

// const ACCESS_EXEC        = 0x1;
// const ACCESS_WRITE       = 0x2;
// const ACCESS_READ        = 0x4;
// const ACCESS_LIST        = 'list';
// const ACCESS_DELETE      = 'delete';
// const ACCESS_CREATE      = 'create';

if (fs.existsSync(getConfigFileName())) {
    config = JSON.parse(fs.readFileSync(getConfigFileName(), 'utf8'));
    if (!config.states)  config.states  = {type: 'file'};
    if (!config.objects) config.objects = {type: 'file'};
} else {
    throw 'Cannot find ' + getConfigFileName();
}

/**
 * getErrorText
 *
 * Read text name of the error number
 *
 * @param {number} code error code
 * @return {string} error description
 */
function getErrorText(code) {
    const texts = Object.keys(EXIT_CODES);
    for (let i = 0; i < texts.length; i++) {
        if (EXIT_CODES[texts[i]] === code) {
            return texts[i];
        }
    }
    return (code || 0).toString();
}

/**
 * Adapter class
 *
 * How the initialization happens:
 *  initObjects => initStates => prepareInitAdapter => createInstancesObjects => initAdapter => initLogging => ready
 *
 * @class
 * @param {string|object} options object like {name: "adapterName", systemConfig: true} or just "adapterName"
 * @return {object} object instance
 */
function Adapter(options) {
    if (!(this instanceof Adapter)) return new Adapter(options);

    if (!options || (!config && !options.config)) throw 'Configuration not set!';

    if (options.config && !options.config.log) options.config.log = config.log;

    config = options.config || config;
    const regUser = /^system\.user\./;
    const regGroup = /^system\.group\./;
    let   firstConnection = true;
    let   systemSecret    = null;
    this.startedInCompactMode = options.compact;

    let reportInterval;

    this.logList = [];
    this.aliases = {};

    this.eventLoopLags = [];

    // possible arguments
    // 0,1,.. - instance
    // info, debug, warn, error - log level
    // --force
    // --logs
    // --silent
    // --install
    // --debug = --force + --logs
    if (process.argv) {
        for (let a = 1; a < process.argv.length; a++) {
            if (process.argv[a] === 'info' || process.argv[a] === 'debug' || process.argv[a] === 'error' || process.argv[a] === 'warn' || process.argv[a] === 'silly') {
                config.log.level = process.argv[a];
            } else if (process.argv[a] === '--silent') {
                config.isInstall = true;
                process.argv[a] = '--install';
            } else if (process.argv[a] === '--install') {
                config.isInstall = true;
            } else if (process.argv[a] === '--logs') {
                config.consoleOutput = true;
            } else if (process.argv[a] === '--force') {
                config.forceIfDisabled = true;
            } else if (process.argv[a] === '--debug') {
                config.forceIfDisabled = true;
                config.consoleOutput   = true;
            } else if (process.argv[a] === '--console') {
                config.consoleOutput   = true;
            } else if (parseInt(process.argv[a], 10).toString() === process.argv[a]) {
                config.instance = parseInt(process.argv[a], 10);
            }
        }
    }

    config.log.level = config.log.level || 'info';

    config.log.noStdout = !config.consoleOutput;

    const logger = require('./logger.js')(config.log);

    // compatibility
    if (!logger.silly) {
        logger.silly = logger.debug;
    }

    // enable "var adapter = require(__dirname + '/../../lib/adapter.js')('adapterName');" call
    if (typeof options === 'string') options = {name: options};

    if (!options.name) throw 'No name of adapter!';

    this._getObjectsByArray = (keys, objects, options, cb, _index, _result, _errors) => {
        if (objects) {
            return cb && cb(null, objects);
        }
        _index  = _index  || 0;
        _result = _result || [];
        _errors = _errors || [];

        while(!keys[_index] && _index < keys.length) _index++;

        if (_index >= keys.length) {
            return cb && cb(_errors.find(e => e) ? _errors : null, _result);
        }

        // if empty => skip immediately
        this.getForeignObject(keys[_index], options, (err, obj) => {
            _result[_index] = obj;
            setImmediate(() => this._getObjectsByArray(keys, objects, options, cb, _index + 1, _result, _errors));
        });
    };

    /**
     * stops the execution of adapter, but not disables it.
     *
     * Sometimes, the adapter must be stopped if some libraries are missing.
     *
     * @alias terminate
     * @memberof Adapter
     * @param {string | number} [reason] optional termination description
     * @param {number} [exitCode] optional exit code
     */
    this.terminate = (reason, exitCode) => {
        // This function must be defined very first, because in the next lines will be yet used.
        if (this.terminated) return;
        this.terminated = true;

        if (reportInterval) {
            clearInterval(reportInterval);
            reportInterval = null;
        }
        if (restartScheduleJob) {
            restartScheduleJob.cancel();
            restartScheduleJob = null;
        }
        if (typeof reason === 'number') {
            // Only the exit code was passed
            exitCode = reason;
            reason = null;
        }
        if (typeof exitCode !== 'number') {
            exitCode = process.argv.indexOf('--install') === -1 ? EXIT_CODES.ADAPTER_REQUESTED_TERMINATION : EXIT_CODES.NO_ERROR;
        }

        const isNotCritical =
            exitCode === EXIT_CODES.ADAPTER_REQUESTED_TERMINATION
            || exitCode === EXIT_CODES.START_IMMEDIATELY_AFTER_STOP
            || exitCode === EXIT_CODES.START_IMMEDIATELY_AFTER_STOP_HEX
            || exitCode === EXIT_CODES.NO_ERROR
        ;

        const text = `${this.namespace} Terminated (${getErrorText(exitCode)}): ${reason ? reason : 'Without reason'}`;
        if (isNotCritical) {
            logger.info(text);
        } else {
            logger.warn(text);
        }
        if (this.startedInCompactMode) {
            if (this.states) {
                this.states.destroy();
                this.states = null;
            }
            if (this.objects) {
                this.objects.destroy();
                this.objects = null;
            }
            this.emit('exit', exitCode, reason);
        } else {
            process.exit(exitCode === undefined ? EXIT_CODES.ADAPTER_REQUESTED_TERMINATION : exitCode);
        }
    };

    // If installed as npm module
    if (options.dirname) {
        this.adapterDir = options.dirname.replace(/\\/g, '/');
    } else {
        this.adapterDir = __dirname.replace(/\\/g, '/').split('/');
        // it can be .../node_modules/appName.js-controller/node_modules/appName.adapter
        //           .../appName.js-controller/node_modules/appName.adapter
        //           .../appName.js-controller/adapter/adapter
        // remove "lib"
        this.adapterDir.pop();
        const jsc = this.adapterDir.pop();
        if ((jsc === tools.appName + '.js-controller' || jsc === tools.appName.toLowerCase() + '.js-controller') && this.adapterDir.pop() === 'node_modules') {
            // js-controller is installed as npm
            const appName = tools.appName.toLowerCase();
            this.adapterDir = this.adapterDir.join('/');
            if (fs.existsSync(this.adapterDir + '/node_modules/' + appName + '.' + options.name)) {
                this.adapterDir += '/node_modules/' + appName + '.' + options.name;
            } else if (fs.existsSync(this.adapterDir + '/node_modules/' + appName + '.js-controller/node_modules/' + appName + '.' + options.name)) {
                this.adapterDir += '/node_modules/' + appName + '.js-controller/node_modules/' + appName + '.' + options.name;
            } else if (fs.existsSync(this.adapterDir + '/node_modules/' + appName + '.js-controller/adapter/' + options.name)) {
                this.adapterDir += '/node_modules/' + appName + '.js-controller/adapter/' + options.name;
            } else if (fs.existsSync(this.adapterDir + '/node_modules/' + tools.appName + '.js-controller/node_modules/' + appName + '.' + options.name)) {
                this.adapterDir += '/node_modules/' + tools.appName + '.js-controller/node_modules/' + appName + '.' + options.name;
            } else {
                logger.error(this.namespace + ' Cannot find directory of adapter ' + options.name);
                this.terminate(EXIT_CODES.CANNOT_FIND_ADAPTER_DIR);
            }
        } else {
            this.adapterDir = __dirname.replace(/\\/g, '/');
            // remove "/lib"
            this.adapterDir = this.adapterDir.substring(0, this.adapterDir.length - 4);
            if (fs.existsSync(this.adapterDir + '/node_modules/' + tools.appName + '.' + options.name)) {
                this.adapterDir += '/node_modules/' + tools.appName + '.' + options.name;
            } else if (fs.existsSync(this.adapterDir + '/../node_modules/' + tools.appName + '.' + options.name)) {
                const parts = this.adapterDir.split('/');
                parts.pop();
                this.adapterDir = parts.join('/') + '/node_modules/' + tools.appName + '.' + options.name;
            } else {
                logger.error(this.namespace + ' Cannot find directory of adapter ' + options.name);
                this.terminate(EXIT_CODES.CANNOT_FIND_ADAPTER_DIR);
            }
        }
    }

    if (fs.existsSync(this.adapterDir + '/package.json')) {
        this.pack = JSON.parse(fs.readFileSync(this.adapterDir + '/package.json', 'utf8'));
    } else {
        logger.info(this.namespace + ' Non npm module. No package.json');
    }

    if (!this.pack || !this.pack.io) {
        if (fs.existsSync(this.adapterDir + '/io-package.json')) {
            this.ioPack = JSON.parse(fs.readFileSync(this.adapterDir + '/io-package.json', 'utf8'));
        } else {
            logger.error(this.namespace + ' Cannot find: ' + this.adapterDir + '/io-package.json');
            this.terminate(EXIT_CODES.CANNOT_FIND_ADAPTER_DIR);
        }
    } else {
        this.ioPack = this.pack.io;
    }

    // If required system configuration. Store it in systemConfig attribute
    if (options.systemConfig) {
        this.systemConfig = config;
    }

    let States;
    if (config.states && config.states.type) {
        if (config.states.type === 'file' || config.states.type === 'redis') {
            States = require('./states/statesInRedis');
        } else {
            throw 'Unknown objects type: ' + config.states.type;
        }
    } else {
        States  = require('./states');
    }

    let Objects;
    if (config.objects && config.objects.type) {
        if (config.objects.type === 'file' || config.objects.type === 'redis') {
            try {
                Objects = require('./objects/objectsInRedis');
            } catch (e) {
                Objects = require('iobroker.objects-redis');
            }
        } else {
            throw 'Unknown objects type: ' + config.objects.type;
        }
    } else {
        Objects = require('./objects');
    }

    const ifaces = os.networkInterfaces();
    const ipArr  = [];
    for (const dev in ifaces) {
        if (!ifaces.hasOwnProperty(dev)) continue;
        /*jshint loopfunc:true */
        ifaces[dev].forEach(details => !details.internal && ipArr.push(details.address));
    }

    const instance = parseInt(options.compactInstance  !== undefined ? options.compactInstance : ((options.instance !== undefined) ? options.instance : (config.instance || 0)), 10);

    this.name            = options.name;
    this.namespace       = options.name + '.' + instance;
    /** The cache of users */
    this.users           = {}; // cache of user groups
    /** The cache of user groups */
    this.groups          = {};
    this.defaultHistory  = null;
    /** An array of instances, that support auto subscribe */
    this.autoSubscribe   = null;
    this.inputCount      = 0;
    this.outputCount     = 0;
    /** A RegExp to test for forbidden chars in object IDs */
    this.FORBIDDEN_CHARS = FORBIDDEN_CHARS;
    /** Whether the adapter has already terminated */
    this.terminated      = false;

    let callbackId = 1;
    this.getPortRunning = null;

    /**
     * Helper function to find next free port
     *
     * Looks for first free TCP port starting with given one:
     * <pre><code>
     *     adapter.getPort(8081, function (port) {
     *         adapter.log.debug('Followinf port is free: ' + port);
     *     });
     * </code></pre>
     *
     * @alias getPort
     * @memberof Adapter
     * @param {number} port port number to start the search for free port
     * @param {string} host optional hostname for the port search
     * @param {function} callback return result
     *        <pre><code>function (port) {}</code></pre>
     */
    this.getPort = (port, host, callback) => {
        if (!port) throw 'adapterGetPort: no port';

        if (typeof host === 'function') {
            callback = host;
            host = null;
        }
        if (!host) host = undefined;

        if (typeof port === 'string') port = parseInt(port, 10);
        this.getPortRunning = {port, host, callback};
        const server = net.createServer();
        try {
            server.listen({port, host},(/* err */) => {
                server.once('close', () => (typeof callback === 'function') && callback(port));
                server.close();
            });
            server.on('error', (/* err */) => {
                setTimeout(() => this.getPort(port + 1, host, callback), 100);
            });
        } catch (e) {
            setImmediate(() => this.getPort(port + 1, host, callback));
        }
    };

    /**
     * Method to check for available Features for adapter development
     *
     * Use it like ...
     * <pre><code>
     *     if (adapter.supportsFeature && adapter.supportsFeature('ALIAS')) {
     *         ...
     *     }
     * </code></pre>

     * @alias supportsFeature
     * @memberof Adapter
     * @param {string} featureName the name of the feature to check
     * @returns {boolean} true/false wether the featufre is in the list of supported features
     */
    this.supportsFeature = (featureName) => {
        return supportedFeatures.includes(featureName);
    };

    /**
     * Promise-version of Adapter.getPort
     */
    this.getPortAsync = tools.promisifyNoError(this.getPort, this);

    /**
     * validates user and password
     *
     *
     * @alias checkPassword
     * @memberof Adapter
     * @param {string} user user name as text
     * @param {string} pw password as text
     * @param {object} options optional user context
     * @param {function} callback return result
     *        <pre><code>
     *            function (result) {
     *              adapter.log.debug('User is valid');
     *            }
     *        </code></pre>
     */
    this.checkPassword = (user, pw, options, callback) => {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }

        if (!callback) throw 'checkPassword: no callback';

        if (user && !regUser.test(user)) {
            user = 'system.user.' + user;
        }
        user = user.toLowerCase();

        this.getForeignObject(user, options, (err, obj) => {
            if (err || !obj || !obj.common || (!obj.common.enabled && user !== 'system.user.admin')) {
                callback(false);
                return;
            }
            password(pw).check(obj.common.password, (err, res) => {
                callback(res);
            });
        });
    };
    /**
     * Promise-version of Adapter.checkPassword
     */
    this.checkPasswordAsync = tools.promisifyNoError(this.checkPassword, this);

    /**
     * sets the user's password
     *
     * @alias setPassword
     * @memberof Adapter
     * @param {string} user user name as text
     * @param {string} pw password as text
     * @param {object} options optional user context
     * @param {function} callback return result
     *        <pre><code>
     *            function (err) {
     *              if (err) adapter.log.error('Cannot set password: ' + err);
     *            }
     *        </code></pre>
     */
    this.setPassword = (user, pw, options, callback) => {
        if (typeof options === 'function') {
            callback = options;
            options  = null;
        }
        if (user && !regUser.test(user)) {
            user = 'system.user.' + user;
        }

        this.getForeignObject(user, options, (err, obj) => {
            if (err || !obj) {
                if (typeof callback === 'function') callback('User does not exist');
                return;
            }
            password(pw).hash(null, null, (err, res) => {
                if (err) {
                    typeof callback === 'function' && callback(err);
                    return;
                }
                this.extendForeignObject(user, {
                    common: {
                        password: res
                    }
                }, options, () => (typeof callback === 'function') && callback(null));
            });
        });

    };
    /**
     * Promise-version of Adapter.setPassword
     */
    this.setPasswordAsync = tools.promisify(this.setPassword, this);

    /**
     * returns if user exists and is in the group
     *
     * This function used mostly internally and the adapter developer do not require it.
     *
     * @alias checkGroup
     * @memberof Adapter
     * @param {string} user user name as text
     * @param {string} group group name
     * @param {object} options optional user context
     * @param {function} callback return result
     *        <pre><code>
     *            function (result) {
     *              if (result) adapter.log.debug('User exists and in the group');
     *            }
     *        </code></pre>
     */
    this.checkGroup = (user, group, options, callback) => {
        if (typeof options === 'function') {
            callback = options;
            options  = null;
        }
        if (user && !regUser.test(user)) {
            user = 'system.user.' + user;
        }
        if (group && !regGroup.test(group)) {
            group = 'system.group.' + group;
        }
        this.getForeignObject(user, options, (err, obj) => {
            if (err || !obj) {
                callback(false);
                return;
            }
            this.getForeignObject(group, options, (err, obj) => {
                if (err || !obj) {
                    callback(false);
                    return;
                }
                if (obj.common.members.indexOf(user) !== -1) {
                    callback(true);
                } else {
                    callback(false);
                }
            });
        });
    };
    /**
     * Promise-version of Adapter.checkGroup
     */
    this.checkGroupAsync = tools.promisifyNoError(this.checkGroup, this);

    /** @typedef {{[permission: string]: {type: 'object' | 'state' | '' | 'other' | 'file', operation: string}}} CommandsPermissions */

    /**
     * get the user permissions
     *
     * This function used mostly internally and the adapter developer do not require it.
     * The function reads permissions of user's groups (it can be more than one) and merge permissions together
     *
     * @alias calculatePermissions
     * @memberof Adapter
     * @param {string} user user name as text
     * @param {CommandsPermissions} commandsPermissions object that describes the access rights like
     *     <pre><code>
     *         // static information
     *         var commandsPermissions = {
     *            getObject:          {type: 'object',    operation: 'read'},
     *            getObjects:         {type: 'object',    operation: 'list'},
     *            getObjectView:      {type: 'object',    operation: 'list'},
     *            setObject:          {type: 'object',    operation: 'write'},
     *            subscribeObjects:   {type: 'object',    operation: 'read'},
     *            unsubscribeObjects: {type: 'object',    operation: 'read'},
     *
     *            getStates:          {type: 'state',     operation: 'list'},
     *            getState:           {type: 'state',     operation: 'read'},
     *            setState:           {type: 'state',     operation: 'write'},
     *            getStateHistory:    {type: 'state',     operation: 'read'},
     *            subscribe:          {type: 'state',     operation: 'read'},
     *            unsubscribe:        {type: 'state',     operation: 'read'},
     *            getVersion:         {type: '',          operation: ''},
     *
     *            httpGet:            {type: 'other',     operation: 'http'},
     *            sendTo:             {type: 'other',     operation: 'sendto'},
     *            sendToHost:         {type: 'other',     operation: 'sendto'},
     *
     *            readFile:           {type: 'file',      operation: 'read'},
     *            readFile64:         {type: 'file',      operation: 'read'},
     *            writeFile:          {type: 'file',      operation: 'write'},
     *            writeFile64:        {type: 'file',      operation: 'write'},
     *            unlink:             {type: 'file',      operation: 'delete'},
     *            rename:             {type: 'file',      operation: 'write'},
     *            mkdir:              {type: 'file',      operation: 'write'},
     *            readDir:            {type: 'file',      operation: 'list'},
     *            chmodFile:          {type: 'file',      operation: 'write'},
     *
     *            authEnabled:        {type: '',          operation: ''},
     *            disconnect:         {type: '',          operation: ''},
     *            listPermissions:    {type: '',          operation: ''},
     *            getUserPermissions: {type: 'object',    operation: 'read'}
     *         };
     *        </code></pre>
     * @param {object} options optional user context
     * @param {function} callback return result
     *        <pre><code>
     *            function (acl) {
     *              // Access control object for admin looks like:
     *              // {
     *              //    file: {
     *              //         read:       true,
     *              //         write:      true,
     *              //         'delete':   true,
     *              //         create:     true,
     *              //         list:       true
     *              //     },
     *              //     object: {
     *              //         read:       true,
     *              //         write:      true,
     *              //         'delete':   true,
     *              //         list:       true
     *              //     },
     *              //     state: {
     *              //         read:       true,
     *              //         write:      true,
     *              //         'delete':   true,
     *              //         create:     true,
     *              //         list:       true
     *              //     },
     *              //     user: 'admin',
     *              //     users:  {
     *              //         read:       true,
     *              //         write:      true,
     *              //         create:     true,
     *              //         'delete':   true,
     *              //         list:       true
     *              //     },
     *              //     other: {
     *              //         execute:    true,
     *              //         http:       true,
     *              //         sendto:     true
     *              //     },
     *              //     groups: ['administrator'] // can be more than one
     *              // }
     *            }
     *        </code></pre>
     */
    this.calculatePermissions = (user, commandsPermissions, options, callback) => {
        if (typeof options === 'function') {
            callback = options;
            options  = null;
        }

        if (!regUser.test(user)) {
            user = 'system.user.' + user;
        }
        // read all groups
        let acl = {user: user};
        if (user === 'system.user.admin') {
            acl.groups = ['system.group.administrator'];
            for (const c in commandsPermissions) {
                if (!commandsPermissions.hasOwnProperty(c) || !commandsPermissions[c].type) continue;
                acl[commandsPermissions[c].type] = acl[commandsPermissions[c].type] || {};
                acl[commandsPermissions[c].type][commandsPermissions[c].operation] = true;
            }

            if (callback) callback(acl);
            return;
        }
        acl.groups = [];
        this.getForeignObjects('*', 'group', null, options, (err, groups) => {
            // aggregate all groups permissions, where this user is
            if (groups) {
                for (const g in groups) {
                    if (!groups.hasOwnProperty(g)) continue;
                    if (groups[g] &&
                        groups[g].common &&
                        groups[g].common.members &&
                        groups[g].common.members.indexOf(user) !== -1) {
                        acl.groups.push(groups[g]._id);
                        if (groups[g]._id === 'system.group.administrator') {
                            acl = {
                                file: {
                                    read:       true,
                                    write:      true,
                                    'delete':   true,
                                    create:     true,
                                    list:       true
                                },
                                object: {
                                    read:       true,
                                    write:      true,
                                    'delete':   true,
                                    list:       true
                                },
                                state: {
                                    read:       true,
                                    write:      true,
                                    'delete':   true,
                                    create:     true,
                                    list:       true
                                },
                                user: user,
                                users:  {
                                    read:       true,
                                    write:      true,
                                    create:     true,
                                    'delete':   true,
                                    list:       true
                                },
                                other: {
                                    execute:    true,
                                    http:       true,
                                    sendto:     true
                                },
                                groups: acl.groups
                            };
                            break;
                        }

                        const gAcl = groups[g].common.acl;
                        try {
                            for (const type in gAcl) {
                                if (!gAcl.hasOwnProperty(type)) continue;

                                // fix bug. Some version have user instead of users.
                                if (type === 'user') {
                                    acl.users = acl.users || {};
                                } else {
                                    acl[type] = acl[type] || {};
                                }
                                for (const op in gAcl[type]) {
                                    if (gAcl[type].hasOwnProperty(op)) {
                                        // fix error
                                        if (type === 'user') {
                                            acl.users[op] = acl.users[op] || gAcl.user[op];
                                        } else {
                                            acl[type][op] = acl[type][op] || gAcl[type][op];
                                        }
                                    }
                                }
                            }
                        } catch (e) {
                            logger.error(this.namespace + ' Cannot set acl: ' + e);
                            logger.error(this.namespace + ' Cannot set acl: ' + JSON.stringify(gAcl));
                            logger.error(this.namespace + ' Cannot set acl: ' + JSON.stringify(acl));
                        }
                    }
                }
            }

            if (callback) callback(acl);
        });
    };
    /**
     * Promise-version of Adapter.calculatePermissions
     */
    this.calculatePermissionsAsync = tools.promisifyNoError(this.calculatePermissions, this);

    const readFileCertificate = (cert) => {
        if (typeof cert === 'string') {
            try {
                if (cert.length < 1024 && fs.existsSync(cert)) {
                    cert = fs.readFileSync(cert).toString();
                    // start watcher of this file
                    fs.watch(cert, (eventType, filename) => {
                        logger.warn(this.namespace + ' New certificate "' + filename + '" detected. Restart adapter');
                        setTimeout(stop, 2000, false, true);
                    });
                }
            } catch (e) {
                // ignore
            }
        }
        return cert;
    };

    /**
     * returns SSL certificates by name
     *
     * This function returns SSL certificates (private key, public cert and chained certificate).
     * Names are defined in the system's configuration in admin, e.g. "defaultPrivate", "defaultPublic".
     * The result can be directly used for creation of https server.
     *
     * @alias getCertificates
     * @memberof Adapter
     * @param {string} publicName public certificate name
     * @param {string} privateName private certificate name
     * @param {string} chainedName optional chained certificate name
     * @param {function} callback return result
     *        <pre><code>
     *            function (err, certs) {
     *              adapter.log.debug('private key: ' + certs.key);
     *              adapter.log.debug('public cert: ' + certs.cert);
     *              adapter.log.debug('chained cert: ' + certs.ca);
     *            }
     *        </code></pre>
     */
    this.getCertificates = (publicName, privateName, chainedName, callback) => {
        if (typeof publicName === 'function') {
            callback = publicName;
            publicName = null;
        }
        if (typeof privateName === 'function') {
            callback = privateName;
            privateName = null;
        }
        if (typeof chainedName === 'function') {
            callback = chainedName;
            chainedName = null;
        }
        publicName  = publicName  || this.config.certPublic;
        privateName = privateName || this.config.certPrivate;
        chainedName = chainedName || this.config.certChained;

        // Load certificates
        this.getForeignObject('system.certificates', null, (err, obj) => {
            if (err || !obj ||
                !obj.native.certificates ||
                !publicName ||
                !privateName ||
                !obj.native.certificates[publicName] ||
                !obj.native.certificates[privateName] ||
                (chainedName && !obj.native.certificates[chainedName])
            ) {
                logger.error(this.namespace + ' Cannot enable secure web server, because no certificates found: ' + publicName + ', ' + privateName + ', ' + chainedName);
                if (callback) callback(tools.ERRORS.ERROR_NOT_FOUND);
            } else {
                let ca;
                if (chainedName) {
                    const chained = readFileCertificate(obj.native.certificates[chainedName]).split('-----END CERTIFICATE-----\r\n');
                    ca = [];
                    for (let c = 0; c < chained.length; c++) {
                        if (chained[c].replace(/(\r\n|\r|\n)/g, '').trim()) {
                            ca.push(chained[c] + '-----END CERTIFICATE-----\r\n');
                        }
                    }
                }
                if (callback) {
                    callback(null, {
                        key:  readFileCertificate(obj.native.certificates[privateName]),
                        cert: readFileCertificate(obj.native.certificates[publicName]),
                        ca:   ca
                    }, obj.native.letsEncrypt);
                }
            }
        });
    };
    /**
     * Promise-version of Adapter.getCertificates
     */
    this.getCertificatesAsync = tools.promisify(this.getCertificates, this);

    /**
     * Restarts an instance of the adapter.
     *
     * @memberof Adapter
     */
    this.restart = () => {
        logger.warn(this.namespace + ' Restart initiated');
        // Restarting an adapter can easily be done by writing the adapter object without changing it
        this.terminate(EXIT_CODES.START_IMMEDIATELY_AFTER_STOP);
    };

    /**
     * Updates the adapter config with new values. Only a subset of the configuration has to be provided,
     * since merging with the existing config is done automatically, e.g. like this:
     *
     * `adapter.updateConfig({prop1: "newValue1"})`
     *
     * After updating the configuration, the adapter is automatically restarted.
     *
     * @param {Record<string, any>} newConfig The new config values to be stored
     */
    this.updateConfig = (newConfig) => {
        // merge the old and new configuration
        const _config = Object.assign({}, this.config, newConfig);
        // update the adapter config object
        const configObjId = `system.adapter.${this.namespace}`;
        this.getForeignObjectAsync(configObjId)
            .then(obj => {
                obj.native = _config;
                return this.setForeignObjectAsync(configObjId, obj);
            })
            .catch(err => logger.error(`${this.namespace} Updating the adapter config failed: ${err}`))
        ;
    };

    /**
     * Disables and stops the adapter instance.
     */
    this.disable = () => {
        // update the adapter config object
        const configObjId = `system.adapter.${this.namespace}`;
        this.getForeignObjectAsync(configObjId)
            .then(obj => {
                obj.common.enabled = false;
                return this.setForeignObjectAsync(configObjId, obj);
            })
            .catch(err => logger.error(`${this.namespace} Disabling the adapter instance failed: ${err}`))
        ;
    };

    /**
     * Reads the encrypted parameter from config.
     *
     * It returns promise if no callback is provided.
     * @param {string} attribute - attribute name in native configuraiton part
     * @param {function} callback - optional callback
     * @returns {object} promise if no callback provided
     *
     */
    this.getEncryptedConfig = (attribute, callback) => {
        if (this.config.hasOwnProperty(attribute)) {
            if (typeof callback !== 'function') {
                return new Promise((reject, resolve) => {
                    this.getEncryptedConfig(attribute, (err, encrypted) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(encrypted);
                        }
                    });
                });
            } else {
                if (systemSecret !== null) {
                    callback(null, tools.decrypt(systemSecret, this.config[attribute]));
                } else {
                    this.getForeignObject('system.config', null, (err, data) => {
                        if (data && data.native) {
                            systemSecret = data.native.secret;
                        }
                        systemSecret = systemSecret || DEFAULT_SECRET;
                        callback(null, tools.decrypt(systemSecret, this.config[attribute]));
                    });
                }
            }
        } else {
            if (typeof callback === 'function') {
                callback('Attribute not found');
            } else {
                return Promise.reject('Attribute not found');
            }
        }
    };

    // Can be later deleted if no more appears
    this.inited = false;

    const extendObjects = (tasks, callback) => {
        if (!tasks || !tasks.length) {
            return typeof callback === 'function' && callback();
        }
        const task = tasks.shift();
        const state = task.state;
        if (state !== undefined) {
            delete task.state;
        }
        this.objects.extendObject(task._id, task, () =>
            state ?
                this.states.setState(task._id, state, () => setImmediate(extendObjects, tasks, callback)) :
                setImmediate(extendObjects, tasks, callback));
    };

    const createInstancesObjects = (instanceObj, callback) => {
        let objs;

        const _id = 'system.adapter.' + this.namespace;

        if (!instanceObj.common.onlyWWW && instanceObj.common.mode !== 'once') {
            objs = [
                {
                    _id:    _id + '.alive',
                    type:   'state',
                    common: {
                        name:   this.namespace + ' alive',
                        type:   'boolean',
                        read:   true,
                        write:  true,
                        role:   'indicator.state'
                    },
                    native: {}
                },
                {
                    _id:    _id + '.connected',
                    type:   'state',
                    common: {
                        name: this.namespace + ' is connected',
                        type: 'boolean',
                        read:   true,
                        write:  false,
                        role: 'indicator.state'
                    },
                    native: {}
                },
                {
                    _id:    _id + '.compactMode',
                    type:   'state',
                    common: {
                        name: this.namespace + '.compactMode',
                        type: 'boolean',
                        read: true,
                        write: false,
                        role: 'indicator.state'
                    },
                    native: {}
                },
                {
                    _id:    _id + '.cpu',
                    type:   'state',
                    common: {
                        name: this.namespace + '.cpu',
                        type: 'number',
                        read: true,
                        write: false,
                        role: 'indicator.state',
                        unit: '% of one core'
                    },
                    native: {}
                },                                {
                    _id:    _id + '.cputime',
                    type:   'state',
                    common: {
                        name: this.namespace + '.cputime',
                        type: 'number',
                        read: true,
                        write: false,
                        role: 'indicator.state',
                        unit: 'seconds'
                    },
                    native: {}
                },
                {
                    _id:    _id + '.memHeapUsed',
                    type:   'state',
                    common: {
                        name: this.namespace + ' heap actually Used',
                        type: 'number',
                        read:   true,
                        write:  false,
                        role: 'indicator.state',
                        unit: 'MB'
                    },
                    native: {}
                },
                {
                    _id:    _id + '.memHeapTotal',
                    type:   'state',
                    common: {
                        name: this.namespace + ' total Size of the Heap',
                        read:   true,
                        write:  false,
                        type: 'number',
                        role: 'indicator.state',
                        unit: 'MB'
                    },
                    native: {}
                },
                {
                    _id:    _id + '.memRss',
                    type:   'state',
                    common: {
                        name: this.namespace + ' resident Set Size',
                        desc: 'Resident set size',
                        read:   true,
                        write:  false,
                        type: 'number',
                        role: 'indicator.state',
                        unit: 'MB'
                    },
                    native: {}
                },
                {
                    _id:    _id + '.uptime',
                    type:   'state',
                    common: {
                        name: this.namespace + ' uptime',
                        type: 'number',
                        read:   true,
                        write:  false,
                        role: 'indicator.state',
                        unit: 'seconds'
                    },
                    native: {}
                },
                {
                    _id:    _id + '.inputCount',
                    type:   'state',
                    common: {
                        name: this.namespace + ' events input counter',
                        desc: 'State\'s inputs in 15 seconds',
                        type: 'number',
                        read: true,
                        write: false,
                        role: 'state',
                        unit: 'events/15 seconds'
                    },
                    native: {}
                },
                {
                    _id:    _id + '.outputCount',
                    type:   'state',
                    common: {
                        name: this.namespace + ' events output counter',
                        desc: 'State\'s outputs in 15 seconds',
                        type: 'number',
                        read: true,
                        write: false,
                        role: 'state',
                        unit: 'events/15 seconds'
                    },
                    native: {}
                },
                {
                    _id:    _id + '.eventLoopLag',
                    type:   'state',
                    common: {
                        name: this.namespace + ' Node.js event loop lag',
                        desc: 'Node.js event loop lag in ms averaged over 15 seconds',
                        type: 'number',
                        read: true,
                        write: false,
                        role: 'state',
                        unit: 'ms'
                    },
                    native: {}
                },
                {
                    _id:    _id + '.sigKill',
                    type:   'state',
                    common: {
                        name:   this.namespace + ' kill signal',
                        type:   'number',
                        read:   true,
                        write:  false,
                        desc:   'Process id that must survive. All other IDs must terminate itself',
                        role:   'state'
                    },
                    native: {}
                },
                {
                    _id:    _id + '.logLevel',
                    type:   'state',
                    common: {
                        name:   this.namespace + ' loglevel',
                        type:   'string',
                        read:   true,
                        write:  true,
                        desc:   'Loglevel of the adapter. Will be set on start with defined value but can be overridden during runtime',
                        role:   'state'
                    },
                    native: {}
                }
            ];
        } else {
            objs = [];
        }

        if (instanceObj.common.wakeup) {
            objs.push({
                _id:    _id + '.wakeup',
                type:   'state',
                common: {
                    name: this.namespace + '.wakeup',
                    read:   true,
                    write:  true,
                    type: 'boolean',
                    role: 'adapter.wakeup'
                },
                native: {}
            });
        }

        if (this.ioPack.instanceObjects) {
            this.ioPack.instanceObjects.forEach((obj) => {
                if (obj && (obj._id || obj.type === 'meta')) {
                    if (obj.common) {
                        if (obj.common.name) {
                            obj.common.name = obj.common.name.replace('%INSTANCE%', instance);
                        }
                        if (obj.common.desc) {
                            obj.common.desc = obj.common.desc.replace('%INSTANCE%', instance);
                        }
                    }
                    if (!obj._id.startsWith(this.namespace)) {
                        // instanceObjects are normally defined without namespace prefix
                        obj._id = this.namespace + '.' + obj._id;
                    }
                    objs.push(obj);
                } else {
                    logger.error(this.namespace + ' ' + options.name + '.' + instance + ' invalid instance object: ' + JSON.stringify(obj));
                }
            });
        }

        extendObjects(objs, callback);
    };

    const prepareInitAdapter = () => {
        this.getForeignState('system.adapter.' + this.namespace + '.alive', null, (err, res) => {
            if (options.instance !== undefined) {
                initAdapter(options);
            } else
            if (!config.isInstall && res && res.val === true && res.ack && !config.forceIfDisabled) {
                logger.error(this.namespace + ' ' + options.name + '.' + instance + ' already running');
                this.terminate(EXIT_CODES.ADAPTER_ALREADY_RUNNING);
            } else {
                this.getForeignObject('system.adapter.' + this.namespace, null, (err, res) => {
                    if ((err || !res) && !config.isInstall) {
                        logger.error(this.namespace + ' ' + options.name + '.' + instance + ' invalid config');
                        this.terminate(EXIT_CODES.INVALID_ADAPTER_CONFIG);
                    } else {
                        createInstancesObjects(res,() => initAdapter(res));
                    }
                });
            }
        });
    };

    const autoSubscribeOn = (cb) => {
        if (!this.autoSubscribe) {
            // collect all
            this.objects.getObjectView('system', 'instance', {startkey: 'system.adapter.', endkey: 'system.adapter.\u9999'}, options, (err, res) => {
                if (res && res.rows) {
                    this.autoSubscribe = [];
                    for (let c = res.rows.length - 1; c >= 0; c--) {
                        if (res.rows[c].value.common.subscribable) {
                            const _id = res.rows[c].id.substring(15);
                            if (this.autoSubscribe.indexOf(_id) === -1) {
                                this.autoSubscribe.push(_id);
                            }
                        }
                    }
                }

                if (typeof cb === 'function') cb();
            });
            // because of autoSubscribe
            this.objects.subscribe('system.adapter.*');
        } else if (typeof cb === 'function') {
            cb();
        }
    };

    const initObjects = (cb) => {
        const objectsInst = new Objects({
            namespace: this.namespace,
            connection: config.objects,
            logger:     logger,
            connected: (objectsInstance) => {
                this.objects = objectsInstance;
                this.connected = true;
                // Read dateformat if using of formatDate is announced
                if (options.useFormatDate) {
                    this.getForeignObject('system.config', (err, data) => {
                        if (data && data.common) {
                            this.dateFormat     = data.common.dateFormat;
                            this.isFloatComma   = data.common.isFloatComma;
                            this.language       = data.common.language;
                            this.longitude      = data.common.longitude;
                            this.latitude       = data.common.latitude;
                            this.defaultHistory = data.common.defaultHistory;
                        }
                        if (data && data.native) {
                            systemSecret = data.native.secret;
                        }
                        typeof cb === 'function' && cb();
                    });
                } else if (typeof cb === 'function') {
                    cb();
                }
            },
            disconnected: () =>
                this.connected = false,
            change: (id, obj) => {
                if (obj === 'null' || obj === '') {
                    obj = null;
                }

                if (!id) {
                    logger.error(this.namespace + ' change ID is empty:  ' + JSON.stringify(obj));
                    return;
                }

                // If desired, that adapter must be terminated
                if (id === 'system.adapter.' + this.namespace && obj && obj.common && obj.common.enabled === false) {
                    logger.info(this.namespace + ' Adapter is disabled => stop');
                    if (!obj.common.enabled) {
                        stop();
                        setTimeout(() => this.terminate(EXIT_CODES.NO_ERROR), 4000);
                    }
                }

                // update language, dateFormat and comma
                if (id === 'system.config' && obj && obj.common && (options.useFormatDate || this.defaultHistory !== undefined)) {
                    this.dateFormat     = obj.common.dateFormat;
                    this.isFloatComma   = obj.common.isFloatComma;
                    this.language       = obj.common.language;
                    this.longitude      = obj.common.longitude;
                    this.latitude       = obj.common.latitude;
                    this.defaultHistory = obj.common.defaultHistory;
                }

                // if alias
                if (id.startsWith(ALIAS_STARTS_WITH)) {
                    Object.keys(this.aliases).forEach(_id => {
                        const alias = this.aliases[_id];

                        // Find entry for this alias
                        if (alias.sourceId === id) {
                            if (obj && obj.common && obj.common.alias && obj.common.alias.id) {
                                // update information
                                const updatedAlias = JSON.parse(JSON.stringify(obj.common.alias));
                                updatedAlias.pattern = alias.pattern;
                                updatedAlias.target = {common: obj.common};
                                updatedAlias.sourceId = alias.sourceId;
                                // if linked ID changed
                                if (obj.common.alias.id !== alias.id) {
                                    this.aliases[obj.common.alias.id] = updatedAlias;

                                    // read new object
                                    this.getForeignObject(obj.common.alias.id, (errors, srcObj) => {
                                        if (srcObj && srcObj.common) {
                                            updatedAlias.source = {common: srcObj.common};
                                        }

                                        // unsubscribe old object
                                        this.states.unsubscribe(alias.id, () =>
                                            this.states.subscribe(obj.common.alias.id));

                                        delete this.aliases[_id];
                                    });
                                } else {
                                    this.aliases[_id] = updatedAlias;
                                }
                            } else {
                                // unsubscribe linked state
                                this.objects.unsubscribe(alias.id);
                                delete this.aliases[_id];
                            }
                        }
                    });
                }

                // update oObjects structure if desired
                if (this.oObjects) {
                    if (obj) {
                        this.oObjects[id] = obj;
                    } else {
                        delete this.oObjects[id];
                    }
                }

                // process autosubscribe adapters
                if (id.startsWith('system.adapter.')) {
                    if (obj && obj.common.subscribable) {
                        const _id = id.substring(15); // 'system.adapter.'.length
                        if (obj.common.enabled) {
                            if (this.autoSubscribe.indexOf(_id) === -1) {
                                this.autoSubscribe.push(_id);
                            }
                        } else {
                            const pos = this.autoSubscribe.indexOf(_id);
                            if (pos !== -1) {
                                this.autoSubscribe.splice(pos, 1);
                            }
                        }
                    }
                }

                // remove protectedNative if not admin or own adapter
                const adapterName = this.namespace.split('.')[0];
                if(obj && obj._id && obj._id.startsWith('system.adapter.') && adapterName !== 'admin' &&
                    adapterName !== obj._id.split('.')[2] && obj.protectedNative && obj.protectedNative.length) {
                    for (const attr of obj.protectedNative) {
                        delete obj.native[attr];
                    } // endFor
                } // endIf

                // It was an error in the calculation
                if ((options.noNamespace || config.noNamespace) && this._namespaceRegExp.test(id)) {
                    // emit 'objectChange' event instantly
                    setImmediate(() => {
                        typeof options.objectChange === 'function' && options.objectChange(id.substring(this.namespace.length + 1), obj);
                        this.emit('objectChange', id.substring(this.namespace.length + 1), obj);
                    });
                } else {
                    setImmediate(() => {
                        typeof options.objectChange === 'function' && options.objectChange(id, obj);
                        // emit 'objectChange' event instantly
                        this.emit('objectChange', id, obj);
                    });
                }
            },
            connectTimeout: (/* err */) => {
                if (config.isInstall) {
                    logger && logger.warn(this.namespace + ' no connection to objects DB');
                    this.terminate(EXIT_CODES.NO_ERROR);
                } else {
                    logger && logger.error(this.namespace + ' no connection to objects DB');
                }
            }
        });

        this._namespaceRegExp = new RegExp('^' + this.namespace);       // chache the regex object 'adapter.0'

        /**
         * @param {string | {device?: string, channel?: string, state?: string}} id
         * @param {boolean} [isPattern=false]
         */
        this._fixId = (id, isPattern/* , type */) => {
            let result  = '';
            // If id is an object
            if (typeof id === 'object') {
                // Add namespace + device + channel
                result = this.namespace + '.' + (id.device ? id.device + '.' : '') + (id.channel ? id.channel + '.' : '') + (id.state ? id.state : '');
            } else {
                result = id;

                if (!this._namespaceRegExp.test(id)) {
                    if (!isPattern) {
                        result = this.namespace + (id ? '.' + id : '');
                    } else {
                        result = this.namespace + '.' + (id ? id : '');
                    }
                }
            }
            return result;
        };

        /**
         * Helper method for `set[Foreign]Object[NotExists]` that also sets the default value if one is configured
         * @param {string} id of the object
         * @param obj The object to set
         * @param {unknown} [options]
         * @param callback
         */
        const setObjectWithDefaultValue = (id, obj, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = undefined;
            }
            this.objects.setObject(id, obj, options, (err, result) => {
                if (!err && obj.common && obj.common.def !== undefined) {
                    this.setState(id, obj.common.def, true, null, () =>
                        typeof callback === 'function' && callback(err, result));
                } else if (typeof callback === 'function') {
                    callback(err, result);
                }
            });
        };

        /**
         * Creates or overwrites object in objectDB.
         *
         * This function can create or overwrite objects in objectDB for this adapter.
         * Only Ids that belong to this adapter can be modified. So the function automatically adds "adapter.X." to ID.
         * <b>common</b>, <b>native</b> and <b>type</b> attributes are mandatory and it will be checked.
         * Additionally type "state" requires <b>role</b>, <b>type</b> and <b>name</b>, e.g.:
         * <pre><code>{
         *     common: {
         *          name: 'object name',
         *          type: 'number', // string, boolean, object, mixed, array
         *          role: 'value'   // see https://github.com/ioBroker/ioBroker/blob/master/doc/SCHEMA.md#state-commonrole
         *     },
         *     native: {},
         *     type: 'state' // channel, device
         * }</code></pre>
         *
         * @alias setObject
         * @memberof Adapter
         * @param {string} id object ID, that must be overwritten or created.
         * @param {object} obj new object
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            function (err, obj) {
         *              // obj is {id: id}
         *              if (err) adapter.log.error('Cannot write object: ' + err);
         *            }
         *        </code></pre>
         */
        this.setObject = (id, obj, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }
            if (!defaultObjs) {
                defaultObjs = require('./defaultObjs.js')('de', '°C', 'EUR');
            }

            if (!obj) {
                logger.error(`${this.namespace} setObject: try to set null object for ${id}`);
                return callback && callback(tools.ERRORS.ERROR_EMPTY_OBJECT);
            }

            if (!id && obj.type !== 'meta') {
                logger.error(tools.appendStackTrace(this.namespace + ' setObject id missing!!'));
                if (typeof callback === 'function') callback('id missing!');
                return;
            }

            if (obj.hasOwnProperty('type')) {
                if (!obj.hasOwnProperty('native')) {
                    logger.warn(this.namespace + ' setObject ' + id + ' (type=' + obj.type + ') property native missing!');
                    obj.native = {};
                }
                // Check property 'common'
                if (!obj.hasOwnProperty('common')) {
                    logger.warn(this.namespace + ' setObject ' + id + ' (type=' + obj.type + ') property common missing!');
                    obj.common = {};
                } else if (obj.type === 'state') {
                    // Try to extend the model for type='state'
                    // Check property 'role' by 'state'
                    if (obj.common.hasOwnProperty('role') && defaultObjs[obj.common.role]) {
                        obj.common = extend(true, {}, defaultObjs[obj.common.role], obj.common);
                    } else if (!obj.common.hasOwnProperty('role')) {
                        logger.warn(this.namespace + ' setObject ' + id + ' (type=' + obj.type + ') property common.role missing!');
                    }
                    if (!obj.common.hasOwnProperty('type')) {
                        logger.warn(this.namespace + ' setObject ' + id + ' (type=' + obj.type + ') property common.type missing!');
                    }
                }

                if (!obj.common.hasOwnProperty('name')) {
                    obj.common.name = id;
                    logger.debug(this.namespace + ' setObject ' + id + ' (type=' + obj.type + ') property common.name missing, using id as name');
                }

                id = this._fixId(id, false/*, obj.type*/);

                if (obj.children || obj.parent) {
                    logger.warn(this.namespace + ' Do not use parent or children for ' + id);
                }
                if (!obj.from) obj.from = 'system.adapter.' + this.namespace;
                if (!obj.user) obj.user = (options ? options.user : '') || 'system.user.admin';
                if (!obj.ts) obj.ts = Date.now();

                setObjectWithDefaultValue(id, obj, options, callback);
            } else {
                logger.error(this.namespace + ' setObject ' + id + ' mandatory property type missing!');
                if (typeof callback === 'function') callback('mandatory property type missing!');
            }
        };
        /**
         * Promise-version of Adapter.setObject
         */
        this.setObjectAsync = tools.promisify(this.setObject, this);

        /**
         * Get all states, channels and devices of this adapter.
         *
         * @alias getAdapterObjects
         * @memberof Adapter
         * @param {function} callback return result
         *        <pre><code>
         *            function (objects) {
         *                for (var id in objects) {
         *                    adapter.log.debug(id);
         *                }
         *            }
         *        </code></pre>
         */
        this.getAdapterObjects = (callback) => {
            const objects = {};

            this.objects.getObjectView('system', 'state', {startkey: this.namespace + '.', endkey: this.namespace + '.\u9999', include_docs: true}, (err, _states) => {
                this.objects.getObjectView('system', 'channel', {startkey: this.namespace + '.', endkey: this.namespace + '.\u9999', include_docs: true}, (err, _channels) => {
                    this.objects.getObjectView('system', 'device', {startkey: this.namespace + '.', endkey: this.namespace + '.\u9999', include_docs: true}, (err, _devices) => {
                        if (_channels) {
                            for (let c = _channels.rows.length - 1; c >= 0; c--) {
                                objects[_channels.rows[c].id] = _channels.rows[c].value;
                            }
                        }
                        if (_devices) {
                            for (let d = _devices.rows.length - 1; d >= 0; d--) {
                                objects[_devices.rows[d].id] = _devices.rows[d].value;
                            }
                        }
                        if (_states) {
                            if (options.states) this.oStates = {};
                            for (let s = _states.rows.length - 1; s >= 0; s--) {
                                objects[_states.rows[s].id] = _states.rows[s].value;
                                if (this.oStates) {
                                    this.oStates[_states.rows[s].id] = null;
                                }
                            }
                        }
                        if (typeof callback === 'function') callback(objects);
                    });
                });
            });
        };
        /**
         * Promise-version of Adapter.getAdapterObjects
         */
        this.getAdapterObjectsAsync = tools.promisifyNoError(this.getAdapterObjects, this);

        /**
         * Extend some object and create it if it does not exist
         *
         * You can change or extend some object. E.g existing object is:
         * <pre><code>
         *     {
         *          common: {
         *              name: 'Adapter name',
         *              desc: 'Description'
         *          },
         *          type: 'state',
         *          native: {
         *              unused: 'text'
         *          }
         *     }
         * </code></pre>
         *
         * If following object will be passed as argument
         *
         * <pre><code>
         *     {
         *          common: {
         *              desc: 'New description',
         *              min: 0,
         *              max: 100
         *          },
         *          native: {
         *              unused: null
         *          }
         *     }
         * </code></pre>
         *
         * We will get as output:
         * <pre><code>
         *     {
         *          common: {
         *              desc: 'New description',
         *              min: 0,
         *              max: 100
         *          },
         *          type: 'state',
         *          native: {
         *          }
         *     }
         * </code></pre>
         *
         *
         * @alias extendObject
         * @memberof Adapter
         * @param {string} id object ID, that must be extended
         * @param {object} obj part that must be extended
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            function (err, obj) {
         *                if (err) adapter.log.error(err);
         *                // obj is {"id": id}
         *            }
         *        </code></pre>
         */
        this.extendObject = (id, obj, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }

            id = this._fixId(id, false/*, obj.type*/);

            const mId = id.replace(FORBIDDEN_CHARS, '_');
            if (mId !== id) {
                logger.warn(`${this.namespace} Used invalid characters: ${id} changed to ${mId}`);
                id = mId;
            }

            if (!obj) {
                logger.error(`${this.namespace} extendObject: try to set null object for ${id}`);
                return callback && callback(tools.ERRORS.ERROR_EMPTY_OBJECT);
            }

            if (obj.children || obj.parent) {
                logger.warn(this.namespace + ' Do not use parent or children for ' + id);
            }
            // delete arrays if they should be changed
            if (obj && (
                (obj.common && obj.common.members) ||
                (obj.native && obj.native.repositories) ||
                (obj.native && obj.native.certificates) ||
                (obj.native && obj.native.devices))
            ) {
                // Read whole object
                this.objects.getObject(id, options, (err, oldObj) => {
                    if (err) {
                        typeof callback === 'function' && callback(err);
                        return;
                    }
                    if (!oldObj) {
                        logger.error(this.namespace + ' Object ' + id + ' not exist!');
                        oldObj = {};
                    }
                    if (obj.native && obj.native.repositories && oldObj.native && oldObj.native.repositories) {
                        oldObj.native.repositories = [];
                    }
                    if (obj.common && obj.common.members && oldObj.common && oldObj.common.members) {
                        oldObj.common.members = [];
                    }
                    if (obj.native && obj.native.certificates && oldObj.native && oldObj.native.certificates) {
                        oldObj.native.certificates = [];
                    }
                    if (obj.native && obj.native.devices && oldObj.native && oldObj.native.devices) {
                        oldObj.native.devices = [];
                    }
                    obj = extend(true, oldObj, obj);

                    if (!obj.from) obj.from = 'system.adapter.' + this.namespace;
                    if (!obj.user) obj.user = (options ? options.user : '') || 'system.user.admin';
                    if (!obj.ts) obj.ts = Date.now();

                    this.objects.setObject(id, obj, options, callback);
                });
            } else {
                if (!obj.from) obj.from = 'system.adapter.' + this.namespace;
                if (!obj.user) obj.user = (options ? options.user : '') || 'system.user.admin';
                if (!obj.ts) obj.ts = Date.now();
                this.objects.extendObject(id, obj, options, callback);
            }
        };
        /**
         * Promise-version of Adapter.extendObject
         */
        this.extendObjectAsync = tools.promisify(this.extendObject, this);

        /**
         * Same as {@link Adapter.setObject}, but for any object.
         *
         * ID must be specified as a full name with adapter namespace. E.g "hm-rpc.0.ABC98989.1.STATE"
         *
         * @alias setForeignObject
         * @memberof Adapter
         * @param {string} id object ID, that must be overwritten or created.
         * @param {object} obj new object
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            function (err, obj) {
         *              // obj is {id: id}
         *              if (err) adapter.log.error('Cannot write object: ' + err);
         *            }
         *        </code></pre>
         */
        this.setForeignObject = (id, obj, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }

            if (!obj) {
                logger.error(`${this.namespace} setForeignObject: try to set null object for ${id}`);
                return callback && callback(tools.ERRORS.ERROR_EMPTY_OBJECT);
            }

            obj.from = obj.from || 'system.adapter.' + this.namespace;
            obj.user = obj.user || (options ? options.user : '') || 'system.user.admin';
            obj.ts   = obj.ts   || Date.now();

            const mId = id.replace(FORBIDDEN_CHARS, '_');
            if (mId !== id) {
                logger.warn(`${this.namespace} Used invalid characters: ${id} changed to ${mId}`);
                id = mId;
            }

            if (obj && obj.common && obj.common.alias && obj.common.alias.id && obj.common.alias.id.startsWith(ALIAS_STARTS_WITH)) {
                return callback && callback('Aliases cannot be used as target for aliases');
            }

            setObjectWithDefaultValue(id, obj, options, callback);
        };
        /**
         * Promise-version of Adapter.setForeignObject
         */
        this.setForeignObjectAsync = tools.promisify(this.setForeignObject, this);

        /**
         * Same as {@link Adapter.extendObject}, but for any object.
         *
         * ID must be specified as a full name with adapter namespace. E.g "hm-rpc.0.ABC98989.1.STATE"
         *
         * @alias extendForeignObject
         * @memberof Adapter
         * @param {string} id object ID, that must be extended
         * @param {object} obj part that must be extended
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            function (err, obj) {
         *                // obj is {"id": id}
         *                if (err) adapter.log.error(err);
         *            }
         *        </code></pre>
         */
        this.extendForeignObject = (id, obj, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }
            const mId = id.replace(FORBIDDEN_CHARS, '_');
            if (mId !== id) {
                logger.warn(`${this.namespace} Used invalid characters: ${id} changed to ${mId}`);
                id = mId;
            }

            if (!obj) {
                logger.error(`${this.namespace} extendForeignObject: try to set null object for ${id}`);
                return callback && callback(tools.ERRORS.ERROR_EMPTY_OBJECT);
            }

            // delete arrays if they should be changed
            if ((obj.native && (obj.native.repositories || obj.native.certificates || obj.native.devices)) ||
                (obj.common && obj.common.members)
            ) {
                // Read whole object
                this.objects.getObject(id, options, (err, oldObj) => {
                    if (err) {
                        typeof callback === 'function' && callback(err);
                        return;
                    }
                    if (!oldObj) {
                        logger.error(this.namespace + ' Object ' + id + ' not exist!');
                        oldObj = {};
                    }
                    if (obj.native && obj.native.repositories && oldObj.native && oldObj.native.repositories) {
                        oldObj.native.repositories = [];
                    }
                    if (obj.common && obj.common.members && oldObj.common && oldObj.common.members) {
                        oldObj.common.members = [];
                    }
                    if (obj.native && obj.native.certificates && oldObj.native && oldObj.native.certificates) {
                        oldObj.native.certificates = [];
                    }
                    if (obj.native && obj.native.devices && oldObj.native && oldObj.native.devices) {
                        oldObj.native.devices = [];
                    }
                    obj = extend(true, oldObj, obj);

                    if (!obj.from) obj.from = 'system.adapter.' + this.namespace;
                    if (!obj.user) obj.user = (options ? options.user : '') || 'system.user.admin';
                    if (!obj.ts) obj.ts = Date.now();

                    this.objects.setObject(id, obj, callback);
                });
            } else {
                if (!obj.from) obj.from = 'system.adapter.' + this.namespace;
                if (!obj.user) obj.user = (options ? options.user : '') || 'system.user.admin';
                if (!obj.ts) obj.ts = Date.now();

                this.objects.extendObject(id, obj, options, callback);
            }
        };
        /**
         * Promise-version of Adapter.extendForeignObject
         */
        this.extendForeignObjectAsync = tools.promisify(this.extendForeignObject, this);

        /**
         * Get object of this instance.
         *
         * It is not required, that ID consists namespace. E.g. to get object of "adapterName.X.myObject", only "myObject" is required as ID.
         *
         * @alias getObject
         * @memberof Adapter
         * @param {string} id exactly object ID (without namespace)
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            function (err, obj) {
         *              if (err) adapter.log.error('Cannot get object: ' + err);
         *            }
         *        </code></pre>
         */
        this.getObject = (id, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }

            this.objects.getObject(this._fixId(id), options, callback);
        };
        /**
         * Promise-version of Adapter.getObject
         */
        this.getObjectAsync = tools.promisify(this.getObject, this);

        /**
         * Read object view from DB.
         *
         * It is required, that ID consists namespace in startkey and endkey. E.g. {startkey: 'hm-rpc.' + adapter.instance + '.', endkey: 'hm-rpc.' + adapter.instance + '.\u9999'}
         * to get all objects of the instance.
         *
         * @alias getObjectView
         * @memberof Adapter
         * @param {string} design name of the design
         * @param {string} search name of the view
         * @param {object} params object containing startkey: first id to include in result; endkey: last id to include in result
         * @param {object} options
         * @param {function} callback return result
         *      <pre><code>
         *          function (err, doc) {
         *              if (doc && doc.rows) {
         *                   for (var i = 0; i < doc.rows.length; i++) {
         *                       var id  = doc.rows[i].id;
         *                        var obj = doc.rows[i].value;
         *                        console.log('Found ' + id + ': ' + JSON.stringify(obj));
         *                   }
         *                           if (!doc.rows.length) console.log('No objects found.');
         *               } else {
         *                   console.log('No objects found: ' + err);
         *               }
         *           }
         *           </code></pre>
         */
        this.getObjectView = (design, search, params, options, callback) => {
            this.objects.getObjectView(design, search, params, options, callback);
        };
        /**
         * Promise-version of Adapter.getObjectView
         */
        this.getObjectViewAsync = tools.promisify(this.getObjectView, this);

        /**
         * Read object list from DB.
         *
         * It is required, that ID consists namespace in startkey and endkey. E.g. {startkey: 'hm-rpc.' + adapter.instance + '.', endkey: 'hm-rpc.' + adapter.instance + '.\u9999'}
         * to get all objects of the instance.
         *
         * @alias getObjectList
         * @memberof Adapter
         *
         * @param {object} params
         * @param {object} options
         * @param {function} callback
         *      <pre><code>
         *          function (err, res) {
         *              if (res && res.rows) {
         *                   for (var i = 0; i < res.rows.length; i++) {
         *                       var id  = res.rows[i].id;
         *                       var obj = res.rows[i].value;
         *                       console.log('Found ' + id + ': ' + JSON.stringify(obj));
         *                   }
         *                   if (!res.rows.length) console.log('No objects found.');
         *              } else {
         *                  console.log('No objects found: ' + err);
         *              }
         *          }
         *       </code></pre>
         */
        this.getObjectList = (params, options, callback) => {
            this.objects.getObjectList(params, options, callback);
        };
        /**
         * Promise-version of Adapter.getObjectList
         */
        this.getObjectListAsync = tools.promisify(this.getObjectList, this);

        /**
         * Get the enum tree.
         *
         * Get enums of specified tree or all enums if nothing specified as object with values.
         * If getEnum called with no enum specified, all enums will be returned:
         * <pre><code>
         *      adapter.getEnums(function (err, enums, requestEnum) {
         *        // All enums
         *        if (err) adapter.log.error('Cannot get object: ' + err);
         *        for (var e in enums) {
         *           adapter.log.debug('Enum "' + e + '" has following members: ' + enums[e].common.members.join(', '));
         *        }
         *      });
         * </code></pre>
         *
         * @alias getEnum
         * @memberof Adapter
         * @param {string} _enum enum name, e.g. 'rooms', 'function' or '' (all enums)
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            function (err, enums, requestEnum) {
         *              // requestEnum is _enum
         *              if (err) adapter.log.error('Cannot get object: ' + err);
         *              for (var e in enums) {
         *                 adapter.log.debug('Enum "' + e + '" has following members: ' + enums[e].common.members.join(', '));
         *              }
         *            }
         *        </code></pre>
         */
        this.getEnum = (_enum, options, callback) => {
            if (typeof _enum === 'function') {
                callback = _enum;
                options = null;
                _enum = '';
            }
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }
            if (!_enum.match('^enum.')) _enum = 'enum.' + _enum;
            const result = {};

            this.objects.getObjectView('system', 'enum', {startkey: _enum + '.', endkey: _enum + '.\u9999'}, options, (err, res) => {
                if (err) {
                    typeof callback === 'function' && callback(err);
                    return;
                }
                for (let t = 0; t < res.rows.length; t++) {
                    result[res.rows[t].id] = res.rows[t].value;
                }
                if (typeof callback === 'function') callback(err, result, _enum);
            });
        };
        /**
         * Promise-version of Adapter.getEnum
         */
        this.getEnumAsync = tools.promisify(this.getEnum, this, ['result', 'requestEnum']);

        /**
         * Read the members of given enums.
         *
         * Get enums of specified tree or all enums if nothing specified as object with values.
         *
         * @alias getEnums
         * @memberof Adapter
         * @param {string|array} _enumList enum name or names, e.g. ['rooms', 'function']
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            function (err, enums) {
         *              // requestEnum is _enum
         *              if (err) adapter.log.error('Cannot get object: ' + err);
         *              // Result is like
         *              // {
         *              //    "enum.rooms": {
         *              //       "enum.rooms.livingroom": {
         *              //           common: {
         *              //              members: ['ID1', 'ID2']
         *              //           }
         *              //       },
         *              //       "enum.rooms.sleepingroom": {
         *              //           common: {
         *              //              members: ['ID3', 'ID4']
         *              //           }
         *              //       }
         *              //    },
         *              //    "enum.functions": {
         *              //       "enum.rooms.light": {
         *              //           common: {
         *              //              members: ['ID1', 'ID6']
         *              //           }
         *              //       },
         *              //       "enum.rooms.weather": {
         *              //           common: {
         *              //              members: ['ID4', 'ID7']
         *              //           }
         *              //       }
         *              //    }
         *              // }
         *            }
         *        </code></pre>
         */
        this.getEnums = (_enumList, options, callback) => {
            if (typeof _enumList === 'function') {
                callback = _enumList;
                _enumList  = null;
            }
            if (typeof options === 'function') {
                callback = options;
                options  = null;
            }
            const _enums = {};
            if (_enumList) {
                if (typeof _enumList === 'string') _enumList = [_enumList];
                let count = 0;
                for (let t = 0; t < _enumList.length; t++) {
                    count++;
                    this.getEnum(_enumList[t], options, (err, list, _enum) => {
                        if (list) _enums[_enum] = list;
                        if (!--count && callback) callback(err, _enums);
                    });
                }
            } else {
                // Read all enums
                this.objects.getObjectView('system', 'enum', {startkey: 'enum.', endkey: 'enum.\u9999'}, options, (err, res) => {
                    // be aware, that res.rows[x].id is the name of enum!
                    if (err) {
                        callback(err);
                        return;
                    }
                    const result = {};
                    if (res && res.rows) {
                        for (let i = 0; i < res.rows.length; i++) {
                            const parts = res.rows[i].id.split('.', 3);
                            if (!parts[2]) continue;
                            if (!result[parts[0] + '.' + parts[1]]) result[parts[0] + '.' + parts[1]] = {};
                            result[parts[0] + '.' + parts[1]][res.rows[i].id] = res.rows[i].value;
                        }
                    }

                    if (callback) callback(err, result);
                });
            }
        };
        /**
         * Promise-version of Adapter.getEnums
         */
        this.getEnumsAsync = tools.promisify(this.getEnums, this);

        /**
         * Get objects by pattern, by specific type and resolve their enums.
         *
         * Get all objects in the system of specified type. E.g.:
         *
         *        <pre><code>
         *            adapter.getForeignObjects('hm-rega.0.*', 'state', ['rooms', 'functions'], function (err, objs) {
         *              if (err) adapter.log.error('Cannot get object: ' + err);
         *              // objs look like:
         *              // {
         *              //    "hm-rega.0.ABC0000.1.STATE": {
         *              //        common: {...},
         *              //        native: {},
         *              //        type: 'state',
         *              //        enums: {
         *              //           'enums.rooms.livingroom': 'Living room',
         *              //           'enums.functions.light': 'Light'
         *              //       }
         *              //    },
         *              //    "hm-rega.0.ABC0000.2.STATE": {
         *              //        common: {...},
         *              //        native: {},
         *              //        type: 'state',
         *              //        enums: {
         *              //           'enums.rooms.sleepingroom': 'Sleeping room',
         *              //           'enums.functions.window': 'Windows'
         *              //       }
         *              //    }
         *            }
         *        </code></pre>
         *
         * @alias getForeignObjects
         * @memberof Adapter
         * @param {string} pattern object ID/wildchars
         * @param {string} type type of object: 'state', 'channel' or 'device'. Default - 'state'
         * @param {string|string[]} enums object ID, that must be overwritten or created.
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            function (err, obj) {
         *              if (err) adapter.log.error('Cannot get object: ' + err);
         *            }
         *        </code></pre>
         */
        this.getForeignObjects = (pattern, type, enums, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }
            let params = {};
            if (pattern && pattern !== '*') {
                params = {
                    startkey: pattern.replace(/\*/g, ''),
                    endkey:   pattern.replace(/\*/g, '\u9999')
                };
            }
            if (typeof enums === 'function') {
                callback = enums;
                enums = null;
            }
            if (typeof type  === 'function') {
                callback = type;
                type = null;
            }
            if (typeof type  === 'object') {
                options = type;
                type = null;
            }
            if (typeof enums === 'object' && !(enums instanceof Array)) {
                options = enums;
                enums = null;
            }
            this.objects.getObjectView('system', type || 'state', params, options, (err, res) => {
                if (err) {
                    callback(err);
                    return;
                }

                // don't forget, that enums returns names in row[x].id and not IDs, you can find id in rows[x].value._id
                this.getEnums(enums, null, (err, _enums) => {
                    const list = {};
                    for (let i = 0; i < res.rows.length; i++) {
                        if (!res.rows[i].value) {
                            logger.debug(`${this.namespace} getEnums(${JSON.stringify(enums)}) returned an enum without a value at index ${i}, obj - ${JSON.stringify(res.rows[i])}`);
                            continue;
                        }
                        const id = res.rows[i].value._id;
                        list[id] = res.rows[i].value;
                        if (_enums && id) {
                            // get device or channel of this state and check it too
                            const parts = id.split('.');
                            parts.splice(parts.length - 1, 1);
                            const channel = parts.join('.');
                            parts.splice(parts.length - 1, 1);
                            const device = parts.join('.');

                            list[id].enums = {};
                            for (const es in _enums) {
                                if (!_enums.hasOwnProperty(es)) continue;
                                for (const e in _enums[es]) {
                                    if (!_enums[es].hasOwnProperty(e)) continue;
                                    if (!_enums[es][e] || !_enums[es][e].common || !_enums[es][e].common.members)
                                        continue;
                                    if (_enums[es][e].common.members.indexOf(id)      !== -1 ||
                                        _enums[es][e].common.members.indexOf(channel) !== -1 ||
                                        _enums[es][e].common.members.indexOf(device)  !== -1) {
                                        list[id].enums[e] = _enums[es][e].common.name;
                                    }
                                }
                            }
                        }
                    }
                    callback(null, list);
                });
            });
        };
        /**
         * Promise-version of Adapter.getForeignObjects
         */
        this.getForeignObjectsAsync = tools.promisify(this.getForeignObjects, this);

        /**
         * Find any object by name or ID.
         *
         * Find object by the exact name or ID.
         *
         * @alias findForeignObject
         * @memberof Adapter
         * @param {string} id exactly object ID (without namespace)
         * @param {string} type optional common.type of state: 'number', 'string', 'boolean', 'file', ...
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            adapter.findForeignObject('Some name', function (err, id, name) {
         *              if (err) adapter.log.error('Cannot get object: ' + err);
         *              adapter.log.debug('ID of object with name "' + name + '" is "' + id + '"');
         *            }
         *        </code></pre>
         */
        this.findForeignObject = (id, type, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }
            if (typeof type === 'function') {
                callback = type;
                type = null;
            }
            this.objects.findObject(id, type, options, callback);
        };
        /**
         * Promise-version of Adapter.findForeignObject
         */
        this.findForeignObjectAsync = tools.promisify(this.findForeignObject, this, ['id', 'name']);

        /**
         * Get any object.
         *
         * ID must be specified with namespace.
         *
         * @alias getForeignObject
         * @memberof Adapter
         * @param {string} id exactly object ID (with namespace)
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            function (err, obj) {
         *              if (err) adapter.log.error('Cannot get object: ' + err);
         *            }
         *        </code></pre>
         */
        this.getForeignObject = (id, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }
            this.objects.getObject(id, options, (err, obj) => {
                const adapterName = this.namespace.split('.')[0];
                // remove protectedNative if not admin or own adapter
                if(obj && obj._id && obj._id.startsWith('system.adapter.') && adapterName !== 'admin' &&
                    adapterName !== obj._id.split('.')[2] && obj.protectedNative && obj.protectedNative.length) {
                    for (const attr of obj.protectedNative) {
                        delete obj.native[attr];
                    } // endFor
                } // endIf
                if (callback && typeof callback === 'function') callback(err, obj);
            });
        };
        /**
         * Promise-version of Adapter.getForeignObject
         */
        this.getForeignObjectAsync = tools.promisify(this.getForeignObject, this);

        /**
         * Delete an object of this instance.
         *
         * It is not required to provice the adapter namespace, because it will automatically be added.
         * E.g. to delete "adapterName.X.myObject", only "myObject" is required as ID.
         *
         * The corresponding state will be deleted too if the object has type "state".
         *
         * @alias delObject
         * @memberof Adapter
         * @param {string} id exactly object ID (without namespace)
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            function (err) {
         *              if (err) adapter.log.error('Cannot delete object: ' + err);
         *            }
         *        </code></pre>
         */
        this.delObject = (id, options, callback) => {
            // delObject does the same as delForeignObject, but fixes the ID first
            id = this._fixId(id);
            this.delForeignObject(id, options, callback);
        };
        /**
         * Promise-version of Adapter.delObject
         */
        this.delObjectAsync = tools.promisify(this.delObject, this);

        /**
         * Delete any object.
         *
         * The full ID with namespace must be specified. The corresponding state will be deleted too if the object has type "state".
         *
         * @alias delForeignObject
         * @memberof Adapter
         * @param {string} id exactly object ID (with namespace)
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            function (err) {
         *              if (err) adapter.log.error('Cannot delete object: ' + err);
         *            }
         *        </code></pre>
         */
        this.delForeignObject = (id, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }

            this.objects.getObject(id, options, (err, obj) => {
                if (err || !obj) {
                    return (typeof callback === 'function') && callback(err || tools.ERRORS.ERROR_NOT_FOUND);
                } else {
                    this.objects.delObject(obj._id, options, err => {
                        if (err || obj.type !== 'state') {
                            return (typeof callback === 'function') && callback(err);
                        } else {
                            this.delForeignState(id, options, callback);
                        }
                    });
                }
            });

        };
        /**
         * Promise-version of Adapter.delForeignObject
         */
        this.delForeignObjectAsync = tools.promisify(this.delForeignObject, this);

        /**
         * Subscribe for the changes of objects in this instance.
         *
         * @alias subscribeObjects
         * @memberof Adapter
         * @param {string} pattern pattern like 'channel.*' or '*' (all objects of this adapter) - without namespaces
         * @param {object} [options] optional user context
         * @param {function} [callback] optional returns result
         *        <pre><code>
         *            function (err) {
         *              if (err) adapter.log.error('Cannot subscribe object: ' + err);
         *            }
         *        </code></pre>
         */
        this.subscribeObjects = (pattern, options, callback) => {
            if (pattern === '*') {
                this.objects.subscribe(this.namespace + '.*', options, callback);
            } else {
                pattern = this._fixId(pattern, true);
                this.objects.subscribe(pattern, options, callback);
            }
        };
        /**
         * Promise-version of Adapter.subscribeObjects
         */
        this.subscribeObjectsAsync = tools.promisify(this.subscribeObjects, this);

        /**
         * Unsubscribe on the changes of objects in this instance.
         *
         * @alias unsubscribeObjects
         * @memberof Adapter
         * @param {string} pattern pattern like 'channel.*' or '*' (all objects) - without namespaces
         * @param {object} options optional user context
         * @param {function} callback optional returns result
         *        <pre><code>
         *            function (err) {
         *              if (err) adapter.log.error('Cannot unsubscribe object: ' + err);
         *            }
         *        </code></pre>
         */
        this.unsubscribeObjects = (pattern, options, callback) => {
            if (pattern === '*') {
                this.objects.unsubscribe(this.namespace + '.*', options, callback);
            } else {
                pattern = this._fixId(pattern, true);
                this.objects.unsubscribe(pattern, options, callback);
            }
        };
        /**
         * Promise-version of Adapter.unsubscribeObjects
         */
        this.unsubscribeObjectsAsync = tools.promisify(this.unsubscribeObjects, this);

        /**
         * Subscribe for the changes of objects in any instance.
         *
         * @alias subscribeForeignObjects
         * @memberof Adapter
         * @param {string} pattern pattern like 'channel.*' or '*' (all objects) - without namespaces. You can use array of patterns
         * @param {object} options optional user context
         * @param {function} callback optional returns result
         *        <pre><code>
         *            function (err) {
         *              if (err) adapter.log.error('Cannot subscribe object: ' + err);
         *            }
         *        </code></pre>
         */
        this.subscribeForeignObjects = (pattern, options, callback) => {
            this.objects.subscribe(pattern, options, callback);
        };
        /**
         * Promise-version of Adapter.subscribeForeignObjects
         */
        this.subscribeForeignObjectsAsync = tools.promisify(this.subscribeForeignObjects, this);

        /**
         * Unsubscribe for the patterns on all objects.
         *
         * @alias unsubscribeForeignObjects
         * @memberof Adapter
         * @param {string} pattern pattern like 'channel.*' or '*' (all objects) - without namespaces
         * @param {object} options optional user context
         * @param {function} callback optional returns result
         *        <pre><code>
         *            function (err) {
         *              if (err) adapter.log.error('Cannot unsubscribe object: ' + err);
         *            }
         *        </code></pre>
         */
        this.unsubscribeForeignObjects = (pattern, options, callback) => {
            if (!pattern) pattern = '*';
            this.objects && this.objects.unsubscribe(pattern, options, callback);
        };
        /**
         * Promise-version of Adapter.unsubscribeForeignObjects
         */
        this.unsubscribeForeignObjectsAsync = tools.promisify(this.unsubscribeForeignObjects, this);

        /**
         * Same as {@link Adapter.setObject}, but with check if the object exists.
         *
         * ID must be specified as a full name with adapter namespace. E.g "hm-rpc.0.ABC98989.1.STATE".
         * New object will be created only if no object exists with such ID.
         *
         * @alias setObjectNotExists
         * @memberof Adapter
         * @param {string} id object ID, that must be overwritten or created.
         * @param {object} obj new object
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            function (err, obj) {
         *              // obj is {id: id}
         *              if (err) adapter.log.error('Cannot write object: ' + err);
         *            }
         *        </code></pre>
         */
        this.setObjectNotExists = (id, obj, options, callback) => {

            if (typeof options === 'function') {
                callback = options;
                options = null;
            }

            id = this._fixId(id);

            if (obj.children || obj.parent) {
                logger.warn(this.namespace + ' Do not use parent or children for ' + id);
            }

            this.objects.getObject(id, options, (err, _obj) => {
                if (!_obj) {
                    if (!obj.from) obj.from = 'system.adapter.' + this.namespace;
                    if (!obj.user) obj.user = (options ? options.user : '') || 'system.user.admin';
                    if (!obj.ts) obj.ts = Date.now();

                    setObjectWithDefaultValue(id, obj, null, callback);
                } else {
                    if (typeof callback === 'function') callback(null);
                }
            });
        };
        /**
         * Promise-version of Adapter.setObjectNotExists
         */
        this.setObjectNotExistsAsync = tools.promisify(this.setObjectNotExists, this);

        /**
         * Same as {@link Adapter.setForeignObject}, but with check if the object exists.
         *
         * ID must be specified as a full name with adapter namespace. E.g "hm-rpc.0.ABC98989.1.STATE".
         * New object will be created only if no object exists with such ID.
         *
         * @alias setForeignObjectNotExists
         * @memberof Adapter
         * @param {string} id object ID, that must be overwritten or created.
         * @param {object} obj new object
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            function (err, obj) {
         *              // obj is {id: id}
         *              if (err) adapter.log.error('Cannot write object: ' + err);
         *            }
         *        </code></pre>
         */
        this.setForeignObjectNotExists = (id, obj, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }
            this.objects.getObject(id, options, (err, _obj) => {
                if (!_obj) {
                    if (!obj.from) obj.from = 'system.adapter.' + this.namespace;
                    if (!obj.user) obj.user = (options ? options.user : '') || 'system.user.admin';
                    if (!obj.ts) obj.ts = Date.now();

                    setObjectWithDefaultValue(id, obj, null, callback);
                } else {
                    if (typeof callback === 'function') callback(null);
                }
            });
        };
        /**
         * Promise-version of Adapter.setForeignObjectNotExists
         */
        this.setForeignObjectNotExistsAsync = tools.promisify(this.setForeignObjectNotExists, this);

        this._DCS2ID = (device, channel, stateOrPoint) => {
            let id = '';
            if (device)  {
                id += device;
            }
            if (channel) {
                id += (id ? '.' : '') + channel;
            }

            if (stateOrPoint !== true && stateOrPoint !== false) {
                if (stateOrPoint)   {
                    id += (id ? '.' : '') + stateOrPoint;
                }
            } else if (stateOrPoint === true && id) {
                id += '.';
            }
            return id;
        };

        this.createDevice = (deviceName, common, _native, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }
            if (!deviceName) {
                logger.error(this.namespace + ' Try to create device with empty name!');
                return;
            }
            if (typeof _native === 'function') {
                callback = _native;
                _native = {};
            }
            if (typeof common === 'function') {
                callback = common;
                common = {};
            }
            common = common || {};
            common.name = common.name || deviceName;

            deviceName = deviceName.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');
            _native = _native || {};

            this.setObjectNotExists(deviceName, {
                type:     'device',
                common:   common,
                native:   _native
            }, options, callback);
        };
        /**
         * Promise-version of Adapter.createDevice
         */
        this.createDeviceAsync = tools.promisify(this.createDevice, this);

        // name of channel must be in format "channel"
        this.createChannel = (parentDevice, channelName, roleOrCommon, _native, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }
            if (!channelName) throw 'Try to create channel without name!';

            if (typeof _native === 'function') {
                callback = _native;
                _native = {};
            }

            if (typeof roleOrCommon === 'function') {
                callback = roleOrCommon;
                roleOrCommon = undefined;
            }

            let common = {};
            if (typeof roleOrCommon === 'string') {
                common = {
                    name: '',
                    role: roleOrCommon
                };
            } else if (typeof roleOrCommon === 'object') {
                common = roleOrCommon;
            }
            common.name = common.name || channelName;

            if (parentDevice) parentDevice = parentDevice.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');
            channelName  = channelName.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');
            channelName  = this._DCS2ID(parentDevice, channelName);

            _native = _native || {};

            const obj = {
                type:     'channel',
                common:   common,
                native:   _native
            };

            this.setObjectNotExists(channelName, obj, options, callback);
        };
        /**
         * Promise-version of Adapter.createChannel
         */
        this.createChannelAsync = tools.promisify(this.createChannel, this);

        this.createState = (parentDevice, parentChannel, stateName, roleOrCommon, _native, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }
            if (!stateName) throw 'Empty name is not allowed!';

            if (typeof _native === 'function') {
                callback = _native;
                _native = {};
            }

            if (typeof roleOrCommon === 'function') {
                callback = roleOrCommon;
                roleOrCommon = undefined;
            }

            let common = {};
            if (typeof roleOrCommon === 'string') {
                common = {
                    read:  true,
                    write: false,
                    name:  '',
                    role:  roleOrCommon
                };
            } else if (typeof roleOrCommon === 'object') {
                common = roleOrCommon;
            }

            common.name = common.name || stateName;
            _native = _native || {};

            common.read  = (common.read  === undefined) ? true  : common.read;
            common.write = (common.write === undefined) ? false : common.write;

            if (!common.role) {
                logger.error(this.namespace + ' Try to create state ' + (parentDevice ? (parentDevice + '.') : '') + parentChannel + '.' + stateName + ' without role');
                return;
            }

            if (parentDevice)  parentDevice  = parentDevice.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');
            if (parentChannel) parentChannel = parentChannel.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');
            stateName = stateName.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');
            const id = this._fixId({device: parentDevice, channel: parentChannel, state: stateName});

            // Check min, max and def values for number
            if (common.type !== undefined && common.type === 'number') {
                let min = 0;
                let max = 0;
                let def = 0;
                let err;
                if (common.min !== undefined) {
                    min = common.min;
                    if (typeof min !== 'number') {
                        min = parseFloat(min);
                        if (isNaN(min)) {
                            err = 'Wrong type of ' + id + '.common.min';
                            logger.error(this.namespace + ' ' + err);
                            if (callback) callback(err);
                            return;
                        } else {
                            common.min = min;
                        }
                    }
                }
                if (common.max !== undefined) {
                    max = common.max;
                    if (typeof max !== 'number') {
                        max = parseFloat(max);
                        if (isNaN(max)) {
                            err = 'Wrong type of ' + id + '.common.max';
                            logger.error(this.namespace + ' ' + err);
                            if (callback) callback(err);
                            return;
                        } else {
                            common.max = max;
                        }
                    }
                }
                if (common.def !== undefined) {
                    def = common.def;
                    if (typeof def !== 'number') {
                        def = parseFloat(def);
                        if (isNaN(def)) {
                            err = 'Wrong type of ' + id + '.common.def';
                            logger.error(this.namespace + ' ' + err);
                            if (callback) callback(err);
                            return;
                        } else {
                            common.def = def;
                        }
                    }
                }
                if (common.min !== undefined && common.max !== undefined && min > max) {
                    common.max = min;
                    common.min = max;
                }
                if (common.def !== undefined && common.min !== undefined && def < min) common.def = min;
                if (common.def !== undefined && common.max !== undefined && def > max) common.def = max;
            }

            this.setObjectNotExists(id, {
                type:     'state',
                common:   common,
                native:   _native
            }, options, callback);

            if(common.def !== undefined) {
                if(common.defAck !== undefined) {
                    this.setState(id, common.def, common.defAck, options, () => {});
                } else {
                    this.setState(id, common.def, options, () => {});
                }
            } else {
                this.setState(id, null, true, options, () => {});
            }
        };
        /**
         * Promise-version of Adapter.createState
         */
        this.createStateAsync = tools.promisify(this.createState, this);

        /**
         * Delete device with all its channels and states.
         *
         * @alias deleteDevice
         * @memberof Adapter
         * @param {string} deviceName is the part of ID like: adapter.instance.<deviceName>
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            function (err, obj) {
         *              // obj is {id: id}
         *              if (err) adapter.log.error('Cannot write object: ' + err);
         *            }
         *        </code></pre>
         */
        this.deleteDevice = (deviceName, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }
            deviceName = deviceName.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');
            if (!this._namespaceRegExp.test(deviceName)) deviceName = this.namespace + '.' + deviceName;

            this.objects.getObjectView('system', 'device', {startkey: deviceName, endkey: deviceName}, options, (err, res) => {
                if (err || !res || !res.rows) {
                    typeof callback === 'function' && callback(err);
                    callback = null;
                    return;
                }
                let cnt = 0;
                if (res.rows.length > 1) {
                    logger.warn(this.namespace + ' Found more than one device ' + deviceName);
                }

                for (let t = 0; t < res.rows.length; t++) {
                    cnt++;
                    this.delObject(res.rows[t].id, options, err => {
                        if (err) {
                            typeof callback === 'function' && callback(err);
                            callback = null;
                            return;
                        }

                        if (!--cnt) {
                            let _cnt = 0;
                            _cnt++;
                            // read channels of device
                            this.objects.getObjectView('system', 'channel', {startkey: deviceName + '.', endkey: deviceName + '.\u9999'}, options, (err, res) => {
                                _cnt--;
                                if (err) {
                                    typeof callback === 'function' && callback(err);
                                    callback = null;
                                    return;
                                }
                                for (let k = 0; k < res.rows.length; k++) {
                                    _cnt++;
                                    this.deleteChannel(deviceName, res.rows[k].id, options, err => {
                                        if (!--_cnt) {
                                            typeof callback === 'function' && callback(err);
                                            callback = null;
                                        } else {
                                            if (err) {
                                                typeof callback === 'function' && callback(err);
                                                callback = null;
                                            }
                                        }
                                    });
                                }
                                if (!_cnt && typeof callback === 'function') {
                                    callback();
                                    callback = null;
                                }
                            });
                            // read states of the device...
                            _cnt++;
                            this.objects.getObjectView('system', 'state', {startkey: deviceName + '.', endkey: deviceName + '.\u9999'}, options, (err, res) => {
                                _cnt--;
                                if (err) {
                                    typeof callback === 'function' && callback(err);
                                    callback = null;
                                    return;
                                }
                                for (let k = 0; k < res.rows.length; k++) {
                                    _cnt++;
                                    this.deleteState(deviceName, '', res.rows[k].id, options, err => {
                                        if (!--_cnt) {
                                            typeof callback === 'function' && callback(err);
                                            callback = null;
                                        } else {
                                            if (err) {
                                                typeof callback === 'function' && callback(err);
                                                callback = null;
                                            }
                                        }
                                    });
                                }
                                if (!_cnt && typeof callback === 'function') {
                                    callback();
                                    callback = null;
                                }
                            });
                        }
                    });
                }
                if (!cnt && typeof callback === 'function') {
                    callback();
                    callback = null;
                }
            });
        };
        /**
         * Promise-version of Adapter.deleteDevice
         */
        this.deleteDeviceAsync = tools.promisify(this.deleteDevice, this);

        this.addChannelToEnum = (enumName, addTo, parentDevice, channelName, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }
            if (parentDevice) {
                if (this._namespaceRegExp.test(parentDevice)) {
                    parentDevice = parentDevice.substring(this.namespace.length + 1);
                }
                parentDevice = parentDevice.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');
            }

            if (this._namespaceRegExp.test(channelName)) {
                channelName = channelName.substring(this.namespace.length + 1);
            }
            if (parentDevice && channelName.substring(0, parentDevice.length) === parentDevice) {
                channelName = channelName.substring(parentDevice.length + 1);
            }
            channelName = channelName.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');

            const objId = this.namespace + '.' + this._DCS2ID(parentDevice, channelName);

            if (addTo.match(/^enum\./)) {
                this.objects.getObject(addTo, options, (err, obj) => {
                    if (err) {
                        typeof callback === 'function' && callback(err);
                        return;
                    } else if (obj) {
                        const pos = obj.common.members.indexOf(objId);
                        if (pos === -1) {
                            obj.common.members.push(objId);
                            obj.from = 'system.adapter.' + this.namespace;
                            obj.user = (options ? options.user : '') || 'system.user.admin';
                            obj.ts = Date.now();

                            this.objects.setObject(obj._id, obj, options, callback);
                        }
                    }
                });
            } else {
                if (enumName.match(/^enum\./)) enumName = enumName.substring(5);

                this.objects.getObject('enum.' + enumName + '.' + addTo, options, (err, obj) => {
                    if (err) {
                        typeof callback === 'function' && callback(err);
                        return;
                    }

                    if (obj) {
                        const pos = obj.common.members.indexOf(objId);
                        if (pos === -1) {
                            obj.common.members.push(objId);

                            obj.from = 'system.adapter.' + this.namespace;
                            obj.user = (options ? options.user : '') || 'system.user.admin';
                            obj.ts = Date.now();

                            this.objects.setObject(obj._id, obj, options, callback);
                        } else {
                            if (callback) callback();
                        }
                    } else {
                        // Create enum
                        this.objects.setObject('enum.' + enumName + '.' + addTo, {
                            common: {
                                name: addTo,
                                members: [objId]
                            },
                            from: 'system.adapter.' + this.namespace,
                            ts: Date.now(),
                            type: 'enum'
                        }, options, callback);
                    }
                });
            }
        };
        /**
         * Promise-version of Adapter.addChannelToEnum
         */
        this.addChannelToEnumAsync = tools.promisify(this.addChannelToEnum, this);

        this.deleteChannelFromEnum = (enumName, parentDevice, channelName, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }
            if (parentDevice) {
                if (parentDevice.substring(0, this.namespace.length) === this.namespace) {
                    parentDevice = parentDevice.substring(this.namespace.length + 1);
                }
                parentDevice = parentDevice.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');
            }

            if (channelName && channelName.substring(0, this.namespace.length) === this.namespace) {
                channelName = channelName.substring(this.namespace.length + 1);
            }
            if (parentDevice && channelName && channelName.substring(0, parentDevice.length) === parentDevice) {
                channelName = channelName.substring(parentDevice.length + 1);
            }
            channelName = channelName || '';
            channelName = channelName.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');

            const objId = this.namespace + '.' + this._DCS2ID(parentDevice, channelName);

            if (enumName) {
                enumName = 'enum.' + enumName + '.';
            } else {
                enumName = 'enum.';
            }

            this.objects.getObjectView('system', 'enum', {startkey: enumName, endkey: enumName + '\u9999'}, options, (err, res) => {
                if (err) {
                    typeof callback === 'function' && callback(err);
                    return;
                }
                if (res) {
                    let count = 0;
                    for (let i = 0; i < res.rows.length; i++) {
                        count++;
                        this.objects.getObject(res.rows[i].id, options, (err, obj) => {
                            if (err) {
                                typeof callback === 'function' && callback(err);
                                callback = null;
                                return;
                            } else if (obj && obj.common && obj.common.members) {
                                const pos = obj.common.members.indexOf(objId);
                                if (pos !== -1) {
                                    obj.common.members.splice(pos, 1);
                                    count++;
                                    obj.from = 'system.adapter.' + this.namespace;
                                    obj.user = (options ? options.user : '') || 'system.user.admin';
                                    obj.ts = Date.now();

                                    this.objects.setObject(obj._id, obj, options, err => {
                                        if (!--count && callback) {
                                            callback(err);
                                        } else {
                                            if (err) {
                                                typeof callback === 'function' && callback(err);
                                                callback = null;
                                            }
                                        }
                                    });
                                }
                            }
                            if (!--count && callback) callback(err);
                        });
                    }
                } else if (callback) {
                    callback (err);
                }
            });
        };
        /**
         * Promise-version of Adapter.deleteChannelFromEnum
         */
        this.deleteChannelFromEnumAsync = tools.promisify(this.deleteChannelFromEnum, this);

        this.deleteChannel = (parentDevice, channelName, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }
            if (typeof channelName === 'function') {
                callback = channelName;
                channelName = parentDevice;
                parentDevice = '';
            }
            if (parentDevice && !channelName) {
                channelName = parentDevice;
                parentDevice = '';
            } else if (parentDevice && typeof channelName === 'function') {
                callback     = channelName;
                channelName  = parentDevice;
                parentDevice = '';
            }
            if (!parentDevice) parentDevice = '';
            this.deleteChannelFromEnum('', parentDevice, channelName);
            const _parentDevice = parentDevice;
            const _channelName  = channelName;

            if (parentDevice) {
                if (this._namespaceRegExp.test(parentDevice)) {
                    parentDevice = parentDevice.substring(this.namespace.length + 1);
                }
                parentDevice = parentDevice.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');
            }

            if (channelName && this._namespaceRegExp.test(channelName)) {
                channelName = channelName.substring(this.namespace.length + 1);
            }
            if (parentDevice && channelName && channelName.substring(0, parentDevice.length) === parentDevice) {
                channelName = channelName.substring(parentDevice.length + 1);
            }
            channelName = channelName || '';
            channelName = channelName.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');

            channelName  = this.namespace + '.' + this._DCS2ID(parentDevice, channelName);

            logger.info(this.namespace + ' Delete channel ' + channelName);

            this.objects.getObjectView('system', 'channel', {startkey: channelName, endkey: channelName}, options, (err, res) => {
                if (err || !res || !res.rows) {
                    typeof callback === 'function' && callback(err);
                    callback = null;
                    return;
                }
                let cnt = 0;
                res.rows.length > 1 && logger.warn(this.namespace + ' Found more than one channel ' + channelName);

                for (let t = 0; t < res.rows.length; t++) {
                    cnt++;
                    this.delObject(res.rows[t].id, options, err => {
                        if (err) {
                            typeof callback === 'function' && callback(err);
                            callback = null;
                            return;
                        }
                        if (!--cnt) {
                            this.objects.getObjectView('system', 'state', {startkey: channelName + '.', endkey: channelName + '.\u9999'}, options, (err, res) => {
                                if (err || !res || !res.rows) {
                                    typeof callback === 'function' && callback(err);
                                    callback = null;
                                    return;
                                }
                                let _cnt = 0;
                                for (let k = 0; k < res.rows.length; k++) {
                                    _cnt++;
                                    this.deleteState(_parentDevice, _channelName, res.rows[k].id, options, err => {
                                        if (!--_cnt && callback) {
                                            callback(err);
                                        } else {
                                            if (err) {
                                                typeof callback === 'function' && callback(err);
                                                callback = null;
                                            }
                                        }
                                    });
                                }
                                if (!_cnt && callback) callback();
                            });
                        }
                    });
                }
                if (!cnt && callback) callback();
            });
        };
        /**
         * Promise-version of Adapter.deleteChannel
         */
        this.deleteChannelAsync = tools.promisify(this.deleteChannel, this);

        this.deleteState = (parentDevice, parentChannel, stateName, options, callback) => {
            if (typeof parentChannel === 'function' && stateName === undefined) {
                stateName     = parentDevice;
                callback      = parentChannel;
                parentChannel = '';
                parentDevice  = '';
            } else
            if (parentChannel === undefined && stateName === undefined) {
                stateName     = parentDevice;
                parentDevice  = '';
                parentChannel = '';
            } else {
                if (typeof options === 'function') {
                    callback = options;
                    options  = null;
                }
                if (typeof stateName === 'function') {
                    callback      = stateName;
                    stateName     = parentChannel;
                    parentChannel = parentDevice;
                    parentDevice  = '';
                }
                if (typeof parentChannel === 'function') {
                    callback      = parentChannel;
                    stateName     = parentDevice;
                    parentChannel = '';
                    parentDevice  = '';
                }
                if (typeof parentChannel === 'function') {
                    callback      = parentChannel;
                    stateName     = parentDevice;
                    parentChannel = '';
                    parentDevice  = '';
                }
            }

            this.deleteStateFromEnum('', parentDevice, parentChannel, stateName, options);

            if (parentDevice) {
                if (this._namespaceRegExp.test(parentDevice)) {
                    parentDevice = parentDevice.substring(this.namespace.length + 1);
                }

                parentDevice = parentDevice.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');
            }

            if (parentChannel) {
                if (this._namespaceRegExp.test(parentChannel)) {
                    parentChannel = parentChannel.substring(this.namespace.length + 1);
                }
                if (parentDevice && parentChannel.substring(0, parentDevice.length) === parentDevice) {
                    parentChannel = parentChannel.substring(parentDevice.length + 1);
                }

                parentChannel = parentChannel.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');
            }

            if (this._namespaceRegExp.test(stateName)) {
                stateName = stateName.substring(this.namespace.length + 1);
            }
            if (parentDevice && stateName.substring(0, parentDevice.length) === parentDevice) {
                stateName = stateName.substring(parentDevice.length + 1);
            }
            if (parentChannel && stateName.substring(0, parentChannel.length) === parentChannel) {
                stateName = stateName.substring(parentChannel.length + 1);
            }
            stateName = stateName || '';
            stateName = stateName.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');

            const _name = this._DCS2ID(parentDevice, parentChannel, stateName);
            this.delObject(_name, options, callback);
        };
        /**
         * Promise-version of Adapter.deleteState
         */
        this.deleteStateAsync = tools.promisify(this.deleteState, this);

        this.getDevices = (options, callback) => {
            if (typeof options === 'function' && typeof callback === 'object') {
                const tmp = callback;
                callback = options;
                options = tmp;
            }
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }

            this.objects.getObjectView('system', 'device', {startkey: this.namespace + '.', endkey: this.namespace + '.\u9999'}, options, (err, obj) => {
                if (callback) {
                    if (obj.rows.length) {
                        const res = [];
                        for (let i = 0; i < obj.rows.length; i++) {
                            res.push(obj.rows[i].value);
                        }
                        callback(null, res);
                    } else {
                        callback(err, []);
                    }
                }
            });
        };
        /**
         * Promise-version of Adapter.getDevices
         */
        this.getDevicesAsync = tools.promisify(this.getDevices, this);

        this.getChannelsOf = (parentDevice, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }
            if (typeof parentDevice === 'function') {
                callback = parentDevice;
                parentDevice = null;
            }
            if (!parentDevice) parentDevice = '';

            if (parentDevice && this._namespaceRegExp.test(parentDevice)) {
                parentDevice = parentDevice.substring(this.namespace.length + 1);
            }

            parentDevice  = parentDevice.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');
            parentDevice = this.namespace + (parentDevice ? ('.' + parentDevice) : '');
            this.objects.getObjectView('system', 'channel', {startkey: parentDevice + '.', endkey: parentDevice + '.\u9999'}, options, (err, obj) => {
                if (callback) {
                    if (obj.rows.length) {
                        const res = [];
                        for (let i = 0; i < obj.rows.length; i++) {
                            res.push(obj.rows[i].value);
                        }
                        callback(null, res);
                    } else {
                        callback(err, []);
                    }
                }
            });
        };
        /**
         * Promise-version of Adapter.getChannelsOf
         */
        this.getChannelsOfAsync = tools.promisify(this.getChannelsOf, this);

        this.getChannels = this.getChannelsOf;

        this.getStatesOf = (parentDevice, parentChannel, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }
            if (typeof parentDevice === 'function') {
                callback = parentDevice;
                parentDevice = null;
                parentChannel = null;
            }
            if (typeof parentChannel === 'function') {
                callback = parentChannel;
                parentChannel = null;
            }

            if (!parentDevice) {
                parentDevice = '';
            } else {
                if (this._namespaceRegExp.test(parentDevice)) {
                    parentDevice = parentDevice.substring(this.namespace.length + 1);
                }

                parentDevice  = parentDevice.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');
            }

            if (!parentChannel) {
                parentChannel = '';
            } else if (this._namespaceRegExp.test(parentChannel)) {
                parentChannel = parentChannel.substring(this.namespace.length + 1);
            }

            if (parentDevice && parentChannel && parentChannel.substring(0, parentDevice.length) === parentDevice) {
                parentChannel = parentChannel.substring(parentDevice.length + 1);
            }

            parentChannel = parentChannel.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');

            const id = this.namespace + '.' + this._DCS2ID(parentDevice, parentChannel, true);

            this.objects.getObjectView('system', 'state', {startkey: id, endkey: id + '\u9999'}, options, (err, obj) => {
                if (callback) {
                    const res = [];
                    if (obj.rows.length) {
                        let read = 0;
                        for (let i = 0; i < obj.rows.length; i++) {
                            read++;
                            this.objects.getObject(obj.rows[i].id, (err, subObj) => {
                                if (subObj) res.push(subObj);

                                if (!--read) callback(null, res);
                            });
                        }
                    } else {
                        callback(null, res);
                    }
                }
            });
        };
        /**
         * Promise-version of Adapter.getStatesOf
         */
        this.getStatesOfAsync = tools.promisify(this.getStatesOf, this);

        this.addStateToEnum = (enumName, addTo, parentDevice, parentChannel, stateName, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }
            if (parentDevice) {
                if (this._namespaceRegExp.test(parentDevice)) {
                    parentDevice = parentDevice.substring(this.namespace.length + 1);
                }

                parentDevice  = parentDevice.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');
            }

            if (parentChannel) {
                if (this._namespaceRegExp.test(parentChannel)) {
                    parentChannel = parentChannel.substring(this.namespace.length + 1);
                }
                if (parentDevice && parentChannel.substring(0, parentDevice.length) === parentDevice) {
                    parentChannel = parentChannel.substring(parentDevice.length + 1);
                }

                parentChannel = parentChannel.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');
            }

            if (this._namespaceRegExp.test(stateName)) {
                stateName = stateName.substring(this.namespace.length + 1);
            }
            if (parentDevice && stateName.substring(0, parentDevice.length) === parentDevice) {
                stateName = stateName.substring(parentDevice.length + 1);
            }
            if (parentChannel && stateName.substring(0, parentChannel.length) === parentChannel) {
                stateName = stateName.substring(parentChannel.length + 1);
            }
            stateName = stateName.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');

            const objId = this._fixId({device: parentDevice, channel: parentChannel, state: stateName});

            if (addTo.match(/^enum\./)) {
                this.objects.getObject(addTo, options, (err, obj) => {
                    if (!err && obj) {
                        const pos = obj.common.members.indexOf(objId);
                        if (pos === -1) {
                            obj.common.members.push(objId);
                            obj.from = 'system.adapter.' + this.namespace;
                            obj.user = (options ? options.user : '') || 'system.user.admin';
                            obj.ts = Date.now();
                            this.objects.setObject(obj._id, obj, options, callback);
                        } else if (callback) {
                            callback();
                        }
                    } else {
                        if (callback) callback(err || tools.ERRORS.ERROR_NOT_FOUND);
                    }
                });
            } else {
                if (enumName.match(/^enum\./)) enumName = enumName.substring(5);

                this.objects.getObject('enum.' + enumName + '.' + addTo, options, (err, obj) => {
                    if (!err && obj) {
                        const pos = obj.common.members.indexOf(objId);
                        if (pos === -1) {
                            obj.common.members.push(objId);
                            obj.from = 'system.adapter.' + this.namespace;
                            obj.user = (options ? options.user : '') || 'system.user.admin';
                            obj.ts = Date.now();
                            this.objects.setObject(obj._id, obj, callback);
                        } else if (callback) {
                            callback();
                        }
                    } else {
                        if (err) {
                            typeof callback === 'function' && callback(err);
                            return;
                        }

                        // Create enum
                        this.objects.setObject('enum.' + enumName + '.' + addTo, {
                            common: {
                                name: addTo,
                                members: [objId]
                            },
                            from: 'system.adapter.' + this.namespace,
                            ts: Date.now(),
                            type: 'enum'
                        }, options, callback);
                    }
                });
            }
        };
        /**
         * Promise-version of Adapter.addStateToEnum
         */
        this.addStateToEnumAsync = tools.promisify(this.addStateToEnum, this);

        this.deleteStateFromEnum = (enumName, parentDevice, parentChannel, stateName, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }
            if (parentDevice) {
                if (this._namespaceRegExp.test(parentDevice)) {
                    parentDevice = parentDevice.substring(this.namespace.length + 1);
                }

                parentDevice  = parentDevice.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');
            }

            if (parentChannel) {
                if (this._namespaceRegExp.test(parentChannel)) {
                    parentChannel = parentChannel.substring(this.namespace.length + 1);
                }
                if (parentDevice && parentChannel.substring(0, parentDevice.length) === parentDevice) {
                    parentChannel = parentChannel.substring(parentDevice.length + 1);
                }

                parentChannel = parentChannel.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');
            }

            if (this._namespaceRegExp.test(stateName)) {
                stateName = stateName.substring(this.namespace.length + 1);
            }
            if (parentDevice && stateName.substring(0, parentDevice.length) === parentDevice) {
                stateName = stateName.substring(parentDevice.length + 1);
            }
            if (parentChannel && stateName.substring(0, parentChannel.length) === parentChannel) {
                stateName = stateName.substring(parentChannel.length + 1);
            }
            stateName = stateName.replace(FORBIDDEN_CHARS, '_').replace(/\./g, '_');

            const objId = this._fixId({device: parentDevice, channel: parentChannel, state: stateName}, false/*, 'state'*/);

            if (enumName) {
                enumName = 'enum.' + enumName + '.';
            } else {
                enumName = 'enum.';
            }

            this.objects.getObjectView('system', 'enum', {startkey: enumName, endkey: enumName + '\u9999'}, options,  (err, res) => {
                if (!err && res) {
                    let count = 0;
                    for (let i = 0; i < res.rows.length; i++) {
                        count++;
                        this.objects.getObject(res.rows[i].id, options, (err, obj) => {
                            if (err) {
                                if (callback) {
                                    callback(err);
                                    callback = null;
                                }
                                return;
                            } else if (obj && obj.common && obj.common.members) {
                                const pos = obj.common.members.indexOf(objId);
                                if (pos !== -1) {
                                    obj.common.members.splice(pos, 1);
                                    count++;
                                    obj.from = 'system.adapter.' + this.namespace;
                                    obj.user = (options ? options.user : '') || 'system.user.admin';
                                    obj.ts = Date.now();
                                    this.objects.setObject(obj._id, obj, err => {
                                        if (!--count && callback) {
                                            callback(err);
                                            callback = null;
                                        }
                                    });
                                }
                            }
                            if (!--count && callback) {
                                callback(err);
                                callback = null;
                            }
                        });
                    }
                    if (!count && callback) {
                        callback();
                        callback = null;
                    }
                } else if (callback) {
                    callback(err);
                    callback = null;
                }
            });
        };
        /**
         * Promise-version of Adapter.deleteStateFromEnum
         */
        this.deleteStateFromEnumAsync = tools.promisify(this.deleteStateFromEnum, this);

        this.chmodFile = (_adapter, path, options, callback) => {
            if (_adapter === null) _adapter = this.name;

            if (typeof options === 'function') {
                callback = options;
                options = null;
            }

            this.objects.chmodFile(_adapter, path, options, callback);
        };
        /**
         * Promise-version of Adapter.chmodFile
         */
        this.chmodFileAsync = tools.promisify(this.chmodFile, this, ['entries', 'id']);

        /**
         * Read directory from DB.
         *
         * This function reads the content of directory from DB for given adapter and path.
         * If getEnum called with no enum specified, all enums will be returned:
         * <pre><code>
         *      adapter.readDir('vis.0', '/main/', function (err, filesOrDirs) {
         *        // All enums
         *        if (err) adapter.log.error('Cannot read directory: ' + err);
         *        if (filesOrDirs) {
         *           for (var f = 0; f < filesOrDirs.length; f++) {
         *              adapter.log.debug('Directory main has following files and dirs: ' + filesOrDirs[f].file + '[dir - ' + filesOrDirs[f].isDir + ']');
         *           }
          *       }
         *      });
         * </code></pre>
         *
         * @alias readDir
         * @memberof Adapter
         * @param {string} _adapter adapter name. If adapter name is null, so the name (not instance) of current adapter will be taken.
         * @param {string} path path to direcory without adapter name. E.g. If you want to read "/vis.0/main/views.json", here must be "/main/views.json" and _adapter must be equal to "vis.0".
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            function (err, filesOrDirs) {
         *                // filesOrDirs is array with elements like
         *                // {
         *                //      file:       'views.json,
         *                //      stats:      node.js stats object like https://nodejs.org/api/fs.html#fs_class_fs_stats ,
         *                //      isDir:      true/false,
         *                //      acl:        access control list object,
         *                //      modifiedAt: time when modified,
         *                //      createdAt:  time when created
         *                // }
         *            }
         *        </code></pre>
         */
        this.readDir = (_adapter, path, options, callback) => {
            if (_adapter === null) _adapter = this.name;

            if (typeof options === 'function') {
                callback = options;
                options = null;
            }

            this.objects.readDir(_adapter, path, options, callback);
        };
        /**
         * Promise-version of Adapter.readDir
         */
        this.readDirAsync = tools.promisify(this.readDir, this);

        this.unlink = (_adapter, name, options, callback) => {
            if (_adapter === null) _adapter = this.name;

            if (typeof options === 'function') {
                callback = options;
                options = null;
            }

            this.objects.unlink(_adapter, name, options, callback);
        };
        /**
         * Promise-version of Adapter.unlink
         */
        this.unlinkAsync = tools.promisify(this.unlink, this);

        this.delFile = this.unlink;
        this.delFileAsync = this.unlinkAsync;

        this.rename = (_adapter, oldName, newName, options, callback) => {
            if (_adapter === null) _adapter = this.name;
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }
            this.objects.rename(_adapter, oldName, newName, options, callback);
        };
        /**
         * Promise-version of Adapter.rename
         */
        this.renameAsync = tools.promisify(this.rename, this);

        this.mkdir = (_adapter, dirname, options, callback) => {
            if (_adapter === null) _adapter = this.name;
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }

            this.objects.mkdir(_adapter, dirname, options, callback);
        };
        /**
         * Promise-version of Adapter.mkdir
         */
        this.mkdirAsync = tools.promisify(this.mkdir, this);

        /**
         * Read file from DB.
         *
         * This function reads the content of one file from DB for given adapter and file name.
         * <pre><code>
         *      adapter.readFile('vis.0', '/main/vis-views.json', function (err, data) {
         *        // All enums
         *        if (err) adapter.log.error('Cannot read file: ' + err);
         *        console.log('Content of file is: ' + data);
         *      });
         * </code></pre>
         *
         * @alias readFile
         * @memberof Adapter
         * @param {string} _adapter adapter name. If adapter name is null, so the name (not instance) of current adapter will be taken.
         * @param {string} filename path to file without adapter name. E.g. If you want to read "/vis.0/main/views.json", here must be "/main/views.json" and _adapter must be equal to "vis.0".
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            function (err, data) {
         *                // data is utf8 or binary Buffer depends on the file extension.
         *            }
         *        </code></pre>
         */
        this.readFile = (_adapter, filename, options, callback) => {
            if (_adapter === null) _adapter = this.name;

            if (typeof options === 'function') {
                callback = options;
                options = null;
            }

            this.objects.readFile(_adapter, filename, options, callback);
        };
        /**
         * Promise-version of Adapter.readFile
         */
        this.readFileAsync = tools.promisify(this.readFile, this, ['file', 'mimeType']);

        /**
         * Write file to DB.
         *
         * This function writes the content of one file into DB for given adapter and file name.
         * <pre><code>
         *      adapter.writeFile('vis.0', '/main/vis-views.json', function (err, data) {
         *        // All enums
         *        if (err) adapter.log.error('Cannot read file: ' + err);
         *        console.log('Content of file is: ' + data);
         *      });
         * </code></pre>
         *
         * @alias readFile
         * @memberof Adapter
         * @param {string} _adapter adapter name. If adapter name is null, so the name (not instance) of current adapter will be taken.
         * @param {string} filename path to file without adapter name. E.g. If you want to read "/vis.0/main/views.json", here must be "/main/views.json" and _adapter must be equal to "vis.0".
         * @param {object} data data as UTF8 string or buffer depends on the file extension.
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            function (err) {
         *
         *            }
         *        </code></pre>
         */
        this.writeFile = (_adapter, filename, data, options, callback) => {
            if (_adapter === null) _adapter = this.name;

            if (typeof options === 'function') {
                callback = options;
                options = null;
            }

            this.objects.writeFile(_adapter, filename, data, options, callback);
        };
        /**
         * Promise-version of Adapter.writeFile
         */
        this.writeFileAsync = tools.promisify(this.writeFile, this);

        this.formatValue = (value, decimals, _format) => {
            if (typeof decimals !== 'number') {
                _format  = decimals;
                decimals = 2;
            }

            const format = (!_format || _format.length !== 2) ? ((this.isFloatComma === undefined) ? '.,' : ((this.isFloatComma) ? '.,' : ',.')) : _format;

            if (typeof value !== 'number') value = parseFloat(value);
            return isNaN(value) ? '' : value.toFixed(decimals).replace(format[0], format[1]).replace(/\B(?=(\d{3})+(?!\d))/g, format[0]);
        };

        this.formatDate = (dateObj, isDuration, _format) => {

            if ((typeof isDuration === 'string' && isDuration.toLowerCase() === 'duration') || isDuration === true) {
                isDuration  = true;
            }
            if (typeof isDuration !== 'boolean') {
                _format    = isDuration;
                isDuration = false;
            }

            if (!dateObj) return '';
            const type = typeof dateObj;
            if (type === 'string') dateObj = new Date(dateObj);

            if (type !== 'object') {
                const j = parseInt(dateObj, 10);
                if (j == dateObj) {
                    // may this is interval
                    if (j < 946681200) {
                        isDuration = true;
                        dateObj = new Date(dateObj);
                    } else {
                        // if less 2000.01.01 00:00:00
                        dateObj = (j < 946681200000) ? new Date(j * 1000) : new Date(j);
                    }
                } else {
                    dateObj = new Date(dateObj);
                }
            }
            const format = _format || this.dateFormat || 'DD.MM.YYYY';

            if (isDuration) dateObj.setMilliseconds(dateObj.getMilliseconds() + dateObj.getTimezoneOffset() * 60 * 1000);

            const validFormatChars = 'YJГMМDTДhSчmмsс';
            let s      = '';
            let result = '';

            const put = (s) => {
                /** @type {number | string} */
                let v = '';
                switch (s) {
                    case 'YYYY':
                    case 'JJJJ':
                    case 'ГГГГ':
                    case 'YY':
                    case 'JJ':
                    case 'ГГ':
                        v = /** @type {Date} */(dateObj).getFullYear();
                        if (s.length === 2) v %= 100;
                        if (v <= 9) v = '0' + v;
                        break;
                    case 'MM':
                    case 'M':
                    case 'ММ':
                    case 'М':
                        v = dateObj.getMonth() + 1;
                        if ((v < 10) && (s.length === 2)) v = '0' + v;
                        break;
                    case 'DD':
                    case 'TT':
                    case 'D':
                    case 'T':
                    case 'ДД':
                    case 'Д':
                        v = dateObj.getDate();
                        if ((v < 10) && (s.length === 2)) v = '0' + v;
                        break;
                    case 'hh':
                    case 'SS':
                    case 'h':
                    case 'S':
                    case 'чч':
                    case 'ч':
                        v = dateObj.getHours();
                        if ((v < 10) && (s.length === 2)) v = '0' + v;
                        break;
                    case 'mm':
                    case 'm':
                    case 'мм':
                    case 'м':
                        v = dateObj.getMinutes();
                        if ((v < 10) && (s.length === 2)) v = '0' + v;
                        break;
                    case 'ss':
                    case 's':
                    case 'cc':
                    case 'c':
                        v = dateObj.getSeconds();
                        if ((v < 10) && (s.length === 2)) v = '0' + v;
                        v = v.toString();
                        break;
                    case 'sss':
                    case 'ссс':
                        v = dateObj.getMilliseconds();
                        if (v < 10) {
                            v = '00' + v;
                        } else if (v < 100) {
                            v = '0' + v;
                        }
                        v = v.toString();
                }
                return result += v;
            };

            for (let i = 0; i < format.length; i++) {
                if (validFormatChars.indexOf(format[i]) >= 0)
                    s += format[i];
                else {
                    put(s);
                    s = '';
                    result += format[i];
                }
            }
            put(s);
            return result;
        };
    };

    const getGroups = (ids, callback, i) => {
        i = i || 0;
        if (!ids || i >= ids.length) {
            callback();
        } else if (this.groups[ids] !== undefined) {
            setImmediate(getGroups, ids, callback, i + 1);
        } else {
            this.getForeignObject(ids[i], null, (err, obj) => {
                this.groups[ids] = obj || {};
                setImmediate(getGroups, ids, callback, i + 1);
            });
        }
    };

    // Cache will be cleared if user or group changes.. Important! only if subscribed.
    const getUserGroups = (options, callback) => {
        if (this.users[options.user]) {
            options.groups = this.users[options.user].groups;
            options.acl    = this.users[options.user].acl;
            return callback(options);
        }
        options.groups = [];
        this.getForeignObject(options.user, null, (err, userAcl) => {
            if (!userAcl) {
                // User does not exists
                logger.error(this.namespace + ' unknown user "' + options.user + '"');
                callback(options);
            } else {
                this.getForeignObjects('*', 'group', null, null, (err, groups) => {
                    // aggregate all groups permissions, where this user is
                    if (groups) {
                        for (const g in groups) {
                            if (groups.hasOwnProperty(g) &&
                                groups[g] &&
                                groups[g].common &&
                                groups[g].common.members &&
                                groups[g].common.members.indexOf(options.user) !== -1) {
                                options.groups.push(groups[g]._id);
                            }
                        }
                    }

                    // read all groups for this user
                    this.users[options.user] = {groups: options.groups, acl: (userAcl.common && userAcl.common.acl) || {}};
                    getGroups(options.groups, () => {
                        // combine all rights
                        const user = this.users[options.user];
                        for (let g = 0; g < options.groups.length; g++) {
                            const gName = options.groups[g];
                            if (!this.groups[gName] || !this.groups[gName].common || !this.groups[gName].common.acl) continue;
                            const group = this.groups[gName];

                            if (group.common.acl && group.common.acl.file) {
                                if (!user.acl || !user.acl.file) {
                                    user.acl      = user.acl || {};
                                    user.acl.file = user.acl.file || {};

                                    user.acl.file.create    = group.common.acl.file.create;
                                    user.acl.file.read      = group.common.acl.file.read;
                                    user.acl.file.write     = group.common.acl.file.write;
                                    user.acl.file['delete'] = group.common.acl.file['delete'];
                                    user.acl.file.list      = group.common.acl.file.list;
                                } else {
                                    user.acl.file.create    = user.acl.file.create    || group.common.acl.file.create;
                                    user.acl.file.read      = user.acl.file.read      || group.common.acl.file.read;
                                    user.acl.file.write     = user.acl.file.write     || group.common.acl.file.write;
                                    user.acl.file['delete'] = user.acl.file['delete'] || group.common.acl.file['delete'];
                                    user.acl.file.list      = user.acl.file.list      || group.common.acl.file.list;
                                }
                            }

                            if (group.common.acl && group.common.acl.object) {
                                if (!user.acl || !user.acl.object) {
                                    user.acl        = user.acl || {};
                                    user.acl.object = user.acl.object || {};

                                    user.acl.object.create    = group.common.acl.object.create;
                                    user.acl.object.read      = group.common.acl.object.read;
                                    user.acl.object.write     = group.common.acl.object.write;
                                    user.acl.object['delete'] = group.common.acl.object['delete'];
                                    user.acl.object.list      = group.common.acl.object.list;
                                } else {
                                    user.acl.object.create    = user.acl.object.create    || group.common.acl.object.create;
                                    user.acl.object.read      = user.acl.object.read      || group.common.acl.object.read;
                                    user.acl.object.write     = user.acl.object.write     || group.common.acl.object.write;
                                    user.acl.object['delete'] = user.acl.object['delete'] || group.common.acl.object['delete'];
                                    user.acl.object.list      = user.acl.object.list      || group.common.acl.object.list;
                                }
                            }

                            if (group.common.acl && group.common.acl.users) {
                                if (!user.acl || !user.acl.users) {
                                    user.acl       = user.acl || {};
                                    user.acl.users = user.acl.users || {};

                                    user.acl.users.create    = group.common.acl.users.create;
                                    user.acl.users.read      = group.common.acl.users.read;
                                    user.acl.users.write     = group.common.acl.users.write;
                                    user.acl.users['delete'] = group.common.acl.users['delete'];
                                    user.acl.users.list      = group.common.acl.users.list;

                                } else {
                                    user.acl.users.create    = user.acl.users.create    || group.common.acl.users.create;
                                    user.acl.users.read      = user.acl.users.read      || group.common.acl.users.read;
                                    user.acl.users.write     = user.acl.users.write     || group.common.acl.users.write;
                                    user.acl.users['delete'] = user.acl.users['delete'] || group.common.acl.users['delete'];
                                    user.acl.users.list      = user.acl.users.list      || group.common.acl.users.list;
                                }
                            }
                            if (group.common.acl && group.common.acl.state) {
                                if (!user.acl || !user.acl.state) {
                                    user.acl       = user.acl || {};
                                    user.acl.state = user.acl.state || {};

                                    user.acl.state.create    = group.common.acl.state.create;
                                    user.acl.state.read      = group.common.acl.state.read;
                                    user.acl.state.write     = group.common.acl.state.write;
                                    user.acl.state['delete'] = group.common.acl.state['delete'];
                                    user.acl.state.list      = group.common.acl.state.list;

                                } else {
                                    user.acl.state.create    = user.acl.state.create    || group.common.acl.state.create;
                                    user.acl.state.read      = user.acl.state.read      || group.common.acl.state.read;
                                    user.acl.state.write     = user.acl.state.write     || group.common.acl.state.write;
                                    user.acl.state['delete'] = user.acl.state['delete'] || group.common.acl.state['delete'];
                                    user.acl.state.list      = user.acl.state.list      || group.common.acl.state.list;
                                }
                            }
                        }
                        options.acl    = user.acl;
                        callback(options);
                    });
                });
            }
        });
    };

    const checkState = (obj, options, command) => {
        const limitToOwnerRights = options.limitToOwnerRights === true;
        if (obj && obj.acl) {
            if (obj.acl.state === undefined) obj.acl.state = obj.acl.object;
            if (obj.acl.state !== undefined) {
                // If user is owner
                if (options.user === obj.acl.owner) {
                    if (command === 'setState' || command === 'delState') {
                        if (command === 'delState' && !options.acl.state['delete']) {
                            logger.warn(`${this.namespace} Permission error for user "${options.user} on "${obj._id}": ${command}`);
                            return false;
                        } else
                        if (command === 'setState' && !options.acl.state.write) {
                            logger.warn(`${this.namespace} Permission error for user "${options.user} on "${obj._id}": ${command}`);
                            return false;
                        } else
                        if (!(obj.acl.state & ACCESS_USER_WRITE)) {
                            logger.warn(`${this.namespace} Permission error for user "${options.user} on "${obj._id}": ${command}`);
                            return false;
                        }
                    } else if (command === 'getState') {
                        if (!(obj.acl.state & ACCESS_USER_READ) || !options.acl.state.read) {
                            logger.warn(`${this.namespace} Permission error for user "${options.user} on "${obj._id}": ${command}`);
                            return false;
                        }
                    } else {
                        logger.warn(this.namespace + ' Called unknown command:' + command);
                    }
                } else if (options.groups.indexOf(obj.acl.ownerGroup) !== -1 && !limitToOwnerRights) {
                    if (command === 'setState' || command === 'delState') {
                        if (command === 'delState' && !options.acl.state['delete']) {
                            logger.warn(`${this.namespace} Permission error for user "${options.user} on "${obj._id}": ${command}`);
                            return false;
                        } else
                        if (command === 'setState' && !options.acl.state.write) {
                            logger.warn(`${this.namespace} Permission error for user "${options.user} on "${obj._id}": ${command}`);
                            return false;
                        } else
                        if (!(obj.acl.state & ACCESS_GROUP_WRITE)) {
                            logger.warn(`${this.namespace} Permission error for user "${options.user} on "${obj._id}": ${command}`);
                            return false;
                        }
                    } else if (command === 'getState') {
                        if (!(obj.acl.state & ACCESS_GROUP_READ) || !options.acl.state.read) {
                            logger.warn(`${this.namespace} Permission error for user "${options.user} on "${obj._id}": ${command}`);
                            return false;
                        }
                    } else {
                        logger.warn(this.namespace + ' Called unknown command:' + command);
                    }
                } else if (!limitToOwnerRights) {
                    if (command === 'setState' || command === 'delState') {
                        if (command === 'delState' && !options.acl.state['delete']) {
                            logger.warn(`${this.namespace} Permission error for user "${options.user} on "${obj._id}": ${command}`);
                            return false;
                        } else
                        if (command === 'setState' && !options.acl.state.write) {
                            logger.warn(`${this.namespace} Permission error for user "${options.user} on "${obj._id}": ${command}`);
                            return false;
                        } else if (!(obj.acl.state & ACCESS_EVERY_WRITE)) {
                            logger.warn('${this.namespace} Permission error for user "' + options.user + '": ' + command);
                            return false;
                        }
                    } else if (command === 'getState') {
                        if (!(obj.acl.state & ACCESS_EVERY_READ) || !options.acl.state.read) {
                            logger.warn('${this.namespace} Permission error for user "' + options.user + '": ' + command);
                            return false;
                        }
                    } else {
                        logger.warn(this.namespace + ' Called unknown command:' + command);
                        return false;
                    }
                } else {
                    logger.warn(this.namespace + ' Permissions limited to Owner rights');
                    return false;
                }
            } else if (limitToOwnerRights) {
                logger.warn(this.namespace + ' Permissions limited to Owner rights');
                return false;
            }
        } else if (limitToOwnerRights) {
            logger.warn(this.namespace + ' Permissions limited to Owner rights');
            return false;
        }

        return true;
    };

    const checkStates = (ids, options, command, callback, _helper) => {
        if (!options.groups) {
            return getUserGroups(options, () => checkStates(ids, options, command, callback));
        }

        if (ids instanceof Array) {
            if (!ids.length) {
                callback(null, ids);
                return;
            }

            if (options._objects) {
                const ids = [];
                const objs = [];
                options._objects.forEach((obj, i) => {
                    if (checkState(options._objects[i], options, command)) {
                        ids.push(obj._id);
                        objs.push(obj);
                    }
                });
                options._objects = undefined;
                callback(null, ids, objs);
            } else {
                _helper = _helper || {
                    i: 0,
                    objs: options._objects || [],
                    errors: []
                };

                // this must be a serial call
                checkStates(ids[_helper.i], options, command, (err, obj) => {
                    if (err && obj) {
                        _helper.errors.push(obj._id);
                    }

                    if (obj) {
                        _helper.objs[_helper.i] = obj;
                    }

                    // if finished
                    if (_helper.i + 1 >= ids.length) {
                        if (_helper.errors.length) {
                            for (let j = ids.length - 1; j >= 0; j--) {
                                if (_helper.errors.indexOf(ids[j]) !== -1) {
                                    ids.splice(j, 1);
                                    _helper.objs.splice(j, 1);
                                }
                            }
                        }

                        callback(null, ids, _helper.objs);
                    } else {
                        _helper.i++;
                        setImmediate(() => checkStates(ids, options, command, callback, _helper));
                    }
                });

            }
        } else {
            let originalChecked = undefined;

            if (options.checked !== undefined) {
                originalChecked = options.checked;
            }

            options.checked = true;

            this.objects.getObject(ids, options, (err, obj) => {
                if (originalChecked !== undefined) {
                    options.checked = originalChecked;
                } else {
                    options.checked = undefined;
                }
                if (err) {
                    return callback(err, {_id: ids});
                } else {
                    if (!checkState(obj, options, command)) {
                        return callback('permissionError', {_id: ids});
                    }
                }
                callback(null, obj);
            });
        }
    };

    // find out default history instance
    const getDefaultHistory = (callback) => {
        if (!this.defaultHistory) {
            // read default history instance from system.config
            return this.getForeignObject('system.config', null, (err, data) => {
                if (data && data.common) {
                    this.defaultHistory = data.common.defaultHistory;
                }
                if (data && data.native) {
                    systemSecret = data.native.secret;
                }

                // if no default history set
                if (!this.defaultHistory) {
                    // read all adapters
                    this.objects.getObjectView('system', 'instance', {startkey: '', endkey: '\u9999'}, (err, _obj) => {
                        if (_obj) {
                            for (let i = 0; i < _obj.rows.length; i++) {
                                if (_obj.rows[i].value.common && _obj.rows[i].value.common.type === 'storage') {
                                    this.defaultHistory = _obj.rows[i].id.substring('system.adapter.'.length);
                                    break;
                                }
                            }
                        }
                        if (!this.defaultHistory) this.defaultHistory = 'history.0';
                        if (callback) callback();
                    });
                } else {
                    if (callback) callback();
                }
            });
        } else {
            if (callback) callback();

        }
    };

    const pattern2RegEx = (pattern) => {
        pattern = (pattern || '').toString()
            .replace(/\$/g, '\\$')
            .replace(/\^/g, '\\^');

        if (pattern !== '*') {
            if (pattern[0] === '*' && pattern[pattern.length - 1] !== '*') pattern += '$';
            if (pattern[0] !== '*' && pattern[pattern.length - 1] === '*') pattern = '^' + pattern;
            if (pattern[0] !== '*' && pattern[pattern.length - 1] !== '*') pattern = '^' + pattern + '$';
        }

        pattern = pattern
            .replace(/\?/g, '\\?')
            .replace(/\./g, '\\.')
            .replace(/\(/g, '\\(')
            .replace(/\)/g, '\\)')
            .replace(/\[/g, '\\[')
            .replace(/]/g, '\\]')
            .replace(/\*/g, '.*');

        return pattern;
    };

    const _setStateChangedHelper = (id, state, callback) => {
        if (id.startsWith(ALIAS_STARTS_WITH)) {
            this.objects.getObject(id, (err, obj) => {
                if (obj && obj.common && obj.common.alias && obj.common.alias.id) {
                    _setStateChangedHelper(obj.common.alias.id, state, callback);
                } else {
                    logger.warn(this.namespace + ' ' + (err || `Alias ${id} has no target 1`));
                    callback(err || `Alias ${id} has no target`);
                }
            });
        } else {
            this.getForeignState(id, null, (err, oldState) => {
                if (err) {
                    typeof callback === 'function' && callback(err);
                } else {
                    let differ = false;
                    if (!oldState) {
                        differ = true;
                    } else
                    if (state.val !== oldState.val) {
                        differ = true;
                    } else
                    if (state.ack !== undefined && state.ack !== oldState.ack) {
                        differ = true;
                    } else
                    if (state.q !== undefined && state.q !== oldState.q) {
                        differ = true;
                    } else
                    if (state.ts !== undefined && state.ts !== oldState.ts) {
                        differ = true;
                    } else
                    // if comment changed
                    if (state.c !== undefined && state.c !== oldState.c) {
                        differ = true;
                    } else
                    if (state.expire !== undefined && state.expire !== oldState.expire) {
                        differ = true;
                    } else
                    if (state.from !== undefined && state.from !== oldState.from) {
                        differ = true;
                    } else
                    if (state.user !== undefined && state.user !== oldState.user) {
                        differ = true;
                    }

                    if (differ) {
                        this.outputCount++;
                        this.states.setState(id, state, (/* err */) =>
                            typeof callback === 'function' && callback(null, id, false));
                    } else {
                        typeof callback === 'function' && callback(null, id, true);
                    }
                }
            });
        }
    };

    // initStates is called from initAdapter
    const initStates = (cb) => {
        logger.debug(this.namespace + ' objectDB connected');

        config.states.maxQueue = config.states.maxQueue || 1000;

        // Internal object, but some special adapters want to access it anyway.
        const _states = new States({
            namespace:  this.namespace,
            connection: config.states,
            connected: (statesInstance) => {
                this.states = statesInstance;
                logger.debug(this.namespace + ' statesDB connected');

                // Subscribe for process exit signal
                this.states.subscribe('system.adapter.' + this.namespace + '.sigKill');

                // Subscribe for loglevel
                this.states.subscribe('system.adapter.' + this.namespace + '.logLevel');

                if (options.subscribable) {
                    this.states.subscribe('system.adapter.' + this.namespace + '.subscribes');
                    this.states.getState('system.adapter.' + this.namespace + '.subscribes', (err, state) => {
                        if (!state || !state.val) {
                            this.patterns = {};
                        } else {
                            try {
                                this.patterns = JSON.parse(state.val);
                                for (const p in this.patterns) {
                                    if (this.patterns.hasOwnProperty(p)) {
                                        this.patterns[p].regex = pattern2RegEx(p);
                                    }
                                }
                            } catch (e) {
                                this.patterns = {};
                            }
                        }
                        if (typeof cb === 'function') cb();
                    });
                } else if (typeof cb === 'function') {
                    cb();
                }
            },
            logger: logger,
            change: (id, state) => {
                this.inputCount++;
                if (state === 'null' || state === '') state = null;

                if (!id || typeof id !== 'string') {
                    console.log('Something is wrong! ' + JSON.stringify(id));
                    return;
                }

                if (id === 'system.adapter.' + this.namespace + '.sigKill') {
                    if (this.startedInCompactMode) {
                        logger.info(this.namespace + ' Got terminate signal.');
                    } else {
                        logger.warn(this.namespace + ' Got terminate signal. Desired PID: ' + (state && state.val) + ' <> own PID ' + process.pid);
                    }
                    // by deletion of state, stop this instance
                    if ((!state || state.val !== process.pid) && !config.forceIfDisabled) {
                        stop();
                        setTimeout(() => this.terminate(EXIT_CODES.NO_ERROR), 4000);
                    }
                    return;
                }

                if (id === 'system.adapter.' + this.namespace + '.logLevel') {
                    if (! config || !config.log || !state || state.ack) return;
                    let currentLevel = config.log.level;
                    if (state.val && state.val !== currentLevel && ['silly','debug', 'info', 'warn', 'error'].includes(state.val)) {
                        config.log.level = state.val;
                        for (const transport in logger.transports) {
                            if (!logger.transports.hasOwnProperty(transport)) continue;
                            if (logger.transports[transport].level === currentLevel) {
                                logger.transports[transport].level = state.val;
                            }
                        }
                        logger.info(this.namespace + ' Loglevel changed from "' + currentLevel + '" to "' + state.val + '"');
                        currentLevel = state.val;
                    } else if (state.val && state.val !== currentLevel) {
                        logger.info(this.namespace + ' Got invalid loglevel "' + state.val + '", ignoring');
                    }
                    this.states.setState('system.adapter.' + this.namespace + '.logLevel', {val: currentLevel, ack: true, from: 'system.adapter.' + this.namespace});
                    return;
                }

                // todo remove it as an error with log will be found
                if (id === 'system.adapter.' + this.namespace + '.checkLogging') {
                    checkLogging();
                    return;
                }

                // someone subscribes or unsubscribes from adapter
                if (options.subscribable && id === 'system.adapter.' + this.namespace + '.subscribes') {
                    let subs;
                    try {
                        subs = JSON.parse(state.val || '{}');
                    } catch (e) {
                        subs = {};
                    }
                    for (const p in subs) {
                        if (subs.hasOwnProperty(p)) {
                            subs[p].regex = pattern2RegEx(p);
                        }
                    }

                    this.patterns = subs;
                    if (typeof options.subscribesChange === 'function') {
                        options.subscribesChange(state);
                    } else {
                        this.emit('subscribesChange', state);
                    }
                    return;
                }

                // Clear cache if accidentally got the message about change (Will work for admin and javascript)
                if (id.match(/^system\.user\./) || id.match(/^system\.group\./)) {
                    this.users = {};
                    this.groups = {};
                }

                // If someone want to have log messages
                if (this.logList && id.match(/\.logging$/)) {
                    const instance = id.substring(0, id.length - '.logging'.length);
                    if (logger) logger.debug(this.namespace + ' ' + instance + ': logging ' + (state ? state.val : false));
                    this.logRedirect(state ? state.val : false, instance);
                } else
                if (id === 'log.system.adapter.' + this.namespace) {
                    this.processLog(state);
                } else
                // If this is messagebox
                if (id === 'messagebox.system.adapter.' + this.namespace && state) {
                    // Read it from fifo list
                    this.states.delMessage('system.adapter.' + this.namespace, state._id);
                    const obj = state;
                    if (obj) {
                        // If callback stored for this request
                        if (obj.callback     &&
                            obj.callback.ack &&
                            obj.callback.id  &&
                            this.callbacks   &&
                            this.callbacks['_' + obj.callback.id]) {
                            // Call callback function
                            if (this.callbacks['_' + obj.callback.id].cb) {
                                this.callbacks['_' + obj.callback.id].cb(obj.message);
                                delete this.callbacks['_' + obj.callback.id];
                            }
                            // delete too old callbacks IDs, like garbage collector
                            const now = Date.now();
                            for (const _id in this.callbacks) {
                                if (now - this.callbacks[_id].time > 3600000) delete this.callbacks[_id];
                            }

                        } else {
                            if (options.message) {
                                // Else inform about new message the adapter
                                options.message(obj);
                            }
                            this.emit('message', obj);
                        }
                    }
                } else {
                    if (this.oStates) {
                        if (!state) {
                            delete this.oStates[id];
                        } else {
                            this.oStates[id] = state;
                        }
                    }

                    if (this.aliases[id]) {
                        const aState = JSON.parse(JSON.stringify(state));

                        tools.formatAliasValue(this.aliases[id].source, this.aliases[id].target, aState);

                        // It was an error in the calculation
                        if (typeof options.stateChange === 'function') {
                            options.stateChange(this.aliases[id].sourceId, aState);
                        } else {
                            // emit 'stateChange' event instantly
                            setImmediate(() =>
                                this.emit('stateChange', this.aliases[id].sourceId, aState));
                        }
                    }

                    // It was an error in the calculation
                    if ((options.noNamespace || config.noNamespace) && this._namespaceRegExp.test(id)) {
                        if (typeof options.stateChange === 'function') {
                            options.stateChange(id.substring(this.namespace.length + 1), state);
                        } else {
                            // emit 'stateChange' event instantly
                            setImmediate(() =>
                                this.emit('stateChange', id.slice(this.namespace.length + 1), state));
                        }

                    } else {
                        if (typeof options.stateChange === 'function') {
                            options.stateChange(id, state);
                        } else {
                            // emit 'stateChange' event instantly
                            setImmediate(() =>
                                this.emit('stateChange', id, state));
                        }
                    }
                }
            },
            connectTimeout: (error) => {
                if (config.isInstall) {
                    logger && logger.warn(this.namespace + ' no connection to states DB');
                    this.terminate(EXIT_CODES.NO_ERROR);
                } else {
                    logger && logger.error(this.namespace + ' no connection to states DB: ' + (error || ''));
                }
            }
        });

        /**
         * Send message to other adapter instance or all instances of adapter.
         *
         * This function sends a message to specific instance or all instances of some specific adapter.
         * If no instance given (e.g. "pushover"), the callback argument will be ignored. Because normally many responses will come.
         *
         * @alias sendTo
         * @memberof Adapter
         * @param {string} instanceName name of the instance where the message must be send to. E.g. "pushover.0" or "system.adapter.pushover.0".
         * @param {string} command command name, like "send", "browse", "list". Command is depend on target adapter implementation.
         * @param {object} message object that will be given as argument for request
         * @param {function} callback optional return result
         *        <pre><code>
         *            function (result) {
         *              // result is target adapter specific and can vary from adapter to adapter
         *              if (!result) adapter.log.error('No response received');
         *            }
         *        </code></pre>
         */
        this.sendTo = (instanceName, command, message, callback) => {
            if ((typeof message === 'function') && (typeof callback === 'undefined')) {
                callback = message;
                message = undefined;
            }
            if (typeof message === 'undefined') {
                message = command;
                command = 'send';
            }
            const obj = {command: command, message: message, from: 'system.adapter.' + this.namespace};

            if (!instanceName.match(/^system\.adapter\./)) instanceName = 'system.adapter.' + instanceName;

            if (typeof message !== 'object') {
                logger.debug(this.namespace + ' sendTo "' + command + '" to ' + instanceName + ' from system.adapter.' + this.namespace + ': ' + message);
            } else {
                logger.debug(this.namespace + ' sendTo "' + command + '" to ' + instanceName + ' from system.adapter.' + this.namespace);
            }

            // If not specific instance
            if (!instanceName.match(/\.[0-9]+$/)) {
                // Send to all instances of adapter
                this.objects.getObjectView('system', 'instance', {startkey: instanceName + '.', endkey: instanceName + '.\u9999'}, (err, _obj) => {
                    if (_obj) {
                        for (let i = 0; i < _obj.rows.length; i++) {
                            this.states.pushMessage(_obj.rows[i].id, obj);
                        }
                    }
                });
            } else {
                if (callback) {
                    if (typeof callback === 'function') {
                        // force subscribe even no messagebox enabled
                        if (!this.common.messagebox && !this.mboxSubscribed) {
                            this.mboxSubscribed = true;
                            this.states.subscribeMessage('system.adapter.' + this.namespace);
                        }

                        obj.callback = {
                            message: message,
                            id:      callbackId++,
                            ack:     false,
                            time:    Date.now()
                        };
                        if (callbackId >= 0xFFFFFFFF) callbackId = 1;
                        if (!this.callbacks) this.callbacks = {};
                        this.callbacks['_' + obj.callback.id] = {cb: callback};

                        // delete too old callbacks IDs
                        const now = Date.now();
                        for (const _id in this.callbacks) {
                            if (now - this.callbacks[_id].time > 3600000) delete this.callbacks[_id];
                        }
                    } else {
                        obj.callback = callback;
                        obj.callback.ack = true;
                    }
                }

                this.states.pushMessage(instanceName, obj);
            }
        };
        /**
         * Promise-version of Adapter.sendTo
         */
        this.sendToAsync = tools.promisifyNoError(this.sendTo, this);

        /**
         * Send message to specific host or to all hosts.
         *
         * This function sends a message to specific host or all hosts.
         * If no host name given (e.g. null), the callback argument will be ignored. Because normally many responses will come.
         *
         * @alias sendToHost
         * @memberof Adapter
         * @param {string} hostName name of the host where the message must be send to. E.g. "myPC" or "system.host.myPC". If argument is empty, the message will be sent to all hosts.
         * @param {string} command command name. One of: "cmdExec", "getRepository", "getInstalled", "getVersion", "getDiagData", "getLocationOnDisk", "getDevList", "getLogs", "delLogs", "readDirAsZip", "writeDirAsZip", "readObjectsAsZip", "writeObjectsAsZip", "checkLogging". Commands can be checked in controller.js (function processMessage)
         * @param {object} message object that will be given as argument for request
         * @param {function} callback optional return result
         *        <pre><code>
         *            function (result) {
         *              // result is target adapter specific and can vary from command to command
         *              if (!result) adapter.log.error('No response received');
         *            }
         *        </code></pre>
         */
        this.sendToHost = (hostName, command, message, callback) => {
            if (typeof message === 'undefined') {
                message = command;
                command = 'send';
            }
            const obj = {command: command, message: message, from: 'system.adapter.' + this.namespace};

            if (hostName && !hostName.startsWith('system.host.')) {
                hostName = 'system.host.' + hostName;
            }

            if (!hostName) {
                // Send to all hosts
                this.objects.getObjectList({startkey: 'system.host.', endkey: 'system.host.' + '\u9999'}, null, (err, res) => {
                    if (!err && res.rows.length) {
                        for (let i = 0; i < res.rows.length; i++) {
                            const parts = res.rows[i].id.split('.');
                            // ignore system.host.name.alive and so on
                            if (parts.length === 3) {
                                this.states.pushMessage(res.rows[i].id, obj);
                            }
                        }
                    }
                });
            } else {
                if (callback) {
                    if (typeof callback === 'function') {
                        // force subscribe even no messagebox enabled
                        if (!this.common.messagebox && !this.mboxSubscribed) {
                            this.mboxSubscribed = true;
                            this.states.subscribeMessage('system.adapter.' + this.namespace);
                        }

                        obj.callback = {
                            message: message,
                            id:      callbackId++,
                            ack:     false,
                            time:    Date.now()
                        };
                        if (callbackId >= 0xFFFFFFFF) {
                            callbackId = 1;
                        }
                        this.callbacks = this.callbacks || {};
                        this.callbacks['_' + obj.callback.id] = {cb: callback};
                    } else {
                        obj.callback     = callback;
                        obj.callback.ack = true;
                    }
                }

                this.states.pushMessage(hostName, obj);
            }
        };
        /**
         * Promise-version of Adapter.sendToHost
         */
        this.sendToHostAsync = tools.promisifyNoError(this.sendToHost, this);

        /**
         * Writes value into states DB.
         *
         * This function can write values into states DB for this adapter.
         * Only Ids that belong to this adapter can be modified. So the function automatically adds "adapter.X." to ID.
         * ack, options and callback are optional
         *
         * @alias setState
         * @memberof Adapter
         * @param {string} id object ID of the state.
         * @param {object|string|number|boolean} state simple value or object with attribues.
         *  If state is object and ack exists too as function argument, function argument has priority.
         *  <pre><code>
         *      {
         *          val:    value,
         *          ack:    true|false,       // default - false; is command(false) or status(true)
         *          ts:     timestampMS,      // default - now
         *          q:      qualityAsNumber,  // default - 0 (ok)
         *          from:   origin,           // default - this adapter
         *          c:      comment,          // default - empty
         *          expire: expireInSeconds   // default - 0
         *      }
         *  </code></pre>
         * @param {boolean} ack optional is command(false) or status(true)
         * @param {object} options optional user context
         * @param {function} callback optional return error and id
         *        <pre><code>
         *            function (err, id) {
         *              if (err) adapter.log.error('Cannot set value for "' + id + '": ' + err);
         *            }
         *        </code></pre>
         */
        this.setState = (id, state, ack, options, callback) => {
            if (typeof state === 'object' && typeof ack !== 'boolean') {
                callback = options;
                options  = ack;
                ack      = undefined;
            }
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }

            id = this._fixId(id, false, 'state');

            if (typeof ack === 'function') {
                callback = ack;
                ack = undefined;
            }

            if (typeof state !== 'object' || state === null || state === undefined) state = {val: state};

            if (ack !== undefined) {
                state.ack = ack;
            }

            state.from = 'system.adapter.' + this.namespace;
            state.user = (options ? options.user : '') || 'system.user.admin';

            if (options && options.user && options.user !== 'system.user.admin') {
                checkStates(id, options, 'setState', (err, obj) => {
                    if (err) {
                        typeof callback === 'function' && callback(err);
                    } else {
                        if (id.startsWith(ALIAS_STARTS_WITH)) {
                            // write alias
                            if (obj && obj.common && obj.common.alias && obj.common.alias.id) {
                                // check the rights
                                checkStates(obj.common.alias.id, options, 'setState', (err, targetObj) => {
                                    if (err) {
                                        typeof callback === 'function' && callback(err);
                                    } else {
                                        // write target state
                                        this.outputCount++;
                                        this.states.setState(obj.common.alias.id, tools.formatAliasValue(obj, targetObj, state), callback);
                                    }
                                });
                            } else {
                                logger.warn(this.namespace + ' ' + (err || `Alias ${id} has no target 2`));
                                callback(err || `Alias ${id} has no target`);
                            }
                        } else {
                            this.outputCount++;
                            this.states.setState(id, state, callback);
                        }
                    }
                });
            } else {
                if (id.startsWith(ALIAS_STARTS_WITH)) {
                    // write alias
                    // read alias id
                    this.objects.getObject(id, options, (err, obj) => {
                        if (obj && obj.common && obj.common.alias && obj.common.alias.id) {
                            // read object for formatting
                            this.objects.getObject(obj.common.alias.id, options, (err, targetObj) => {
                                // write target state
                                this.outputCount++;
                                this.states.setState(obj.common.alias.id, tools.formatAliasValue(obj, targetObj, state), callback);
                            });
                        } else {
                            logger.warn(this.namespace + ' ' + (err || `Alias ${id} has no target 3`));
                            callback(err || `Alias ${id} has no target`);
                        }
                    });
                } else {
                    this.outputCount++;
                    this.states.setState(id, state, callback);
                }
            }
        };
        /**
         * Promise-version of Adapter.setState
         */
        this.setStateAsync = tools.promisify(this.setState, this);

        /**
         * Writes value into states DB only if the value really changed.
         *
         * This function can write values into states DB for this adapter.
         * Only Ids that belong to this adapter can be modified. So the function automatically adds "adapter.X." to ID.
         * ack, options and callback are optional
         *
         * @alias setStateChanged
         * @memberof Adapter
         * @param {string} id object ID of the state.
         * @param {object|string|number|boolean} state simple value or object with attribues.
         * @param {boolean} ack optional is command(false) or status(true)
         * @param {object} options optional user context
         * @param {function} callback optional return error, id and notChanged
         *        <pre><code>
         *            function (err, id, notChanged) {
         *              if (err) adapter.log.error('Cannot set value for "' + id + '": ' + err);
         *              if (!notChanged) adapter.log.debug('Value was changed');
         *            }
         *        </code></pre>
         */
        this.setStateChanged = (id, state, ack, options, callback) => {
            if (typeof state === 'object' && typeof ack !== 'boolean') {
                callback = options;
                options  = ack;
                ack      = undefined;
            }
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }

            id = this._fixId(id, false/*, 'state'*/);

            if (typeof ack === 'function') {
                callback = ack;
                ack = undefined;
            }

            if (typeof state !== 'object' || state === null || state === undefined) state = {val: state};

            if (ack !== undefined) {
                state.ack = ack;
            }

            state.from = 'system.adapter.' + this.namespace;
            if (options && options.user && options.user !== 'system.user.admin') {
                checkStates(id, options, 'setState', err => {
                    if (err) {
                        typeof callback === 'function' && callback(err);
                    } else {
                        _setStateChangedHelper(id, state, callback);
                    }
                });
            } else {
                _setStateChangedHelper(id, state, callback);
            }
        };
        /**
         * Promise-version of Adapter.setStateChanged
         */
        this.setStateChangedAsync = tools.promisify(this.setStateChanged, this, ['id', 'notChanged']);

        /**
         * Writes value into states DB for any instance.
         *
         * This function can write values into states DB for all instances and system states too.
         * ack, options and callback are optional
         *
         * @alias setForeignState
         * @memberof Adapter
         * @param {string} id object ID of the state.
         * @param {object|string|number|boolean} state simple value or object with attribues.
         *  If state is object, so the ack will be ignored and must be included into object.
         *  <pre><code>
         *      {
         *          val:    value,
         *          ack:    true|false,       // default - false; is command(false) or status(true)
         *          ts:     timestampMS,      // default - now
         *          q:      qualityAsNumber,  // default - 0 (ok)
         *          from:   origin,           // default - this adapter
         *          c:      comment,          // default - empty
         *          expire: expireInSeconds   // default - 0
         *      }
         *  </code></pre>
         * @param {boolean} ack optional is command(false) or status(true)
         * @param {object} options optional user context
         * @param {function} callback optional return error and id
         *        <pre><code>
         *            function (err, id) {
         *              if (err) adapter.log.error('Cannot set value for "' + id + '": ' + err);
         *            }
         *        </code></pre>
         */
        this.setForeignState = (id, state, ack, options, callback) => {
            if (typeof state === 'object' && typeof ack !== 'boolean') {
                callback = options;
                options  = ack;
                ack = undefined;
            }

            if (typeof options === 'function') {
                callback = options;
                options = {};
            }

            if (typeof ack === 'function') {
                callback = ack;
                ack = undefined;
            }

            if (typeof state !== 'object' || state === null || state === undefined) {
                state = {val: state};
            }

            if (ack !== undefined) {
                state.ack = ack;
            }

            state.from = 'system.adapter.' + this.namespace;
            state.user = (options ? options.user : '') || 'system.user.admin';

            if (!id || typeof id !== 'string') {
                const warn = id ? `ID can be only string and not "${typeof id}"` : `Empty ID: ${JSON.stringify(state)}`;
                logger.warn(this.namespace + ' ' + warn);
                return (typeof callback === 'function') && callback(warn);
            }

            const mId = id.replace(FORBIDDEN_CHARS, '_');
            if (mId !== id) {
                logger.warn(`${this.namespace} Used invalid characters: ${id} changed to ${mId}`);
                id = mId;
            }

            if (options && options.user && options.user !== 'system.user.admin') {
                checkStates(id, options, 'setState', (err, obj) => {
                    if (err) {
                        typeof callback === 'function' && callback(err);
                    } else {
                        if (id.startsWith(ALIAS_STARTS_WITH)) {
                            // write alias
                            if (obj && obj.common && obj.common.alias && obj.common.alias.id) {
                                // check the rights
                                checkStates(obj.common.alias.id, options, 'setState', (err, targetObj) => {
                                    if (err) {
                                        typeof callback === 'function' && callback(err);
                                    } else {
                                        this.outputCount++;
                                        this.states.setState(obj.common.alias.id, tools.formatAliasValue(obj, targetObj, state), callback);
                                    }
                                });
                            } else {
                                logger.warn(this.namespace + ' ' + (err || `Alias ${id} has no target 4`));
                                callback(err || `Alias ${id} has no target`);
                            }
                        } else {
                            this.outputCount++;
                            this.states.setState(id, state, callback);
                        }
                    }
                });
            } else {
                // write alias
                if (id.startsWith(ALIAS_STARTS_WITH)) {
                    // read alias id
                    this.objects.getObject(id, options, (err, obj) => {
                        if (obj && obj.common && obj.common.alias && obj.common.alias.id) {
                            // read object for formatting
                            this.objects.getObject(obj.common.alias.id, options, (err, targetObj) => {
                                this.outputCount++;
                                this.states.setState(obj.common.alias.id, tools.formatAliasValue(obj, targetObj, state), callback);
                            });
                        } else {
                            logger.warn(this.namespace + ' ' + (err || `Alias ${id} has no target 5`));
                            callback(err || `Alias ${id} has no target`);
                        }
                    });
                } else {
                    this.outputCount++;
                    this.states.setState(id, state, callback);
                }
            }
        };
        /**
         * Promise-version of Adapter.setForeignState
         */
        this.setForeignStateAsync = tools.promisify(this.setForeignState, this);

        /**
         * Writes value into states DB for any instance, but only if state changed.
         *
         * This function can write values into states DB for all instances and system states too.
         * ack, options and callback are optional
         *
         * @alias setForeignStateChanged
         * @memberof Adapter
         * @param {string} id object ID of the state.
         * @param {object|string|number|boolean} state simple value or object with attribues.
         *  If state is object and ack exists too as function argument, function argument has priority.
         *  <pre><code>
         *      {
         *          val:    value,
         *          ack:    true|false,       // default - false; is command(false) or status(true)
         *          ts:     timestampMS,      // default - now
         *          q:      qualityAsNumber,  // default - 0 (ok)
         *          from:   origin,           // default - this adapter
         *          c:      comment,          // default - empty
         *          expire: expireInSeconds   // default - 0
         *      }
         *  </code></pre>
         * @param {boolean} ack optional is command(false) or status(true)
         * @param {object} options optional user context
         * @param {function} callback optional return error and id
         *        <pre><code>
         *            function (err, id) {
         *              if (err) adapter.log.error('Cannot set value for "' + id + '": ' + err);
         *            }
         *        </code></pre>
         */
        this.setForeignStateChanged = (id, state, ack, options, callback) => {
            if (typeof state === 'object' && typeof ack !== 'boolean') {
                callback = options;
                options  = ack;
                ack = undefined;
            }

            if (typeof options === 'function') {
                callback = options;
                options = {};
            }

            if (typeof ack === 'function') {
                callback = ack;
                ack = undefined;
            }

            if (typeof state !== 'object' || state === null || state === undefined) state = {val: state};

            if (ack !== undefined) {
                state.ack = ack;
            }

            state.from = 'system.adapter.' + this.namespace;
            state.user = (options ? options.user : '') || 'system.user.admin';

            const mId = id.replace(FORBIDDEN_CHARS, '_');
            if (mId !== id) {
                logger.warn(`${this.namespace} Used invalid characters: ${id} changed to ${mId}`);
                id = mId;
            }

            if (options && options.user && options.user !== 'system.user.admin') {
                checkStates(id, options, 'setState', err => {
                    if (err) {
                        typeof callback === 'function' && callback(err);
                    } else {
                        _setStateChangedHelper(id, state, callback);
                    }
                });
            } else {
                _setStateChangedHelper(id, state, callback);
            }
        };
        /**
         * Promise-version of Adapter.setForeignStateChanged
         */
        this.setForeignStateChangedAsync = tools.promisify(this.setForeignStateChanged, this);

        /**
         * Read value from states DB.
         *
         * This function can read values from states DB for this adapter.
         * Only Ids that belong to this adapter can be read. So the function automatically adds "adapter.X." to ID.
         *
         * @alias getState
         * @memberof Adapter
         * @param {string} id object ID of the state.
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            function (err, state) {
         *              if (err) adapter.log.error('Cannot read value: ' + err);
         *            }
         *        </code></pre>
         *
         *        See possible attributes of the state in @setState explanation
         */
        this.getState = (id, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }

            if (typeof callback !== 'function') {
                return;
            }

            id = this._fixId(id, false, 'state');

            if (options && options.user && options.user !== 'system.user.admin') {
                checkStates(id, options, 'getState', err => {
                    if (err) {
                        callback(err);
                    } else {
                        if (id.startsWith(ALIAS_STARTS_WITH)) {
                            this.objects.getObject(id, options, (err, obj) => {
                                if (obj && obj.common && obj.common.alias && (obj.common.alias.id || obj.common.alias.val !== undefined)) {
                                    if (this.oStates && this.oStates[obj.common.alias.id]) {
                                        this.objects.getObject(obj.common.alias.id, (err, sourceObj) => {
                                            const state = JSON.parse(JSON.stringify(this.oStates[obj.common.alias.id]));
                                            callback(err, tools.formatAliasValue(sourceObj, obj, state));
                                        });
                                    } else {
                                        this.objects.getObject(obj.common.alias.id, (err, sourceObj) => {
                                            this.states.getState(obj.common.alias.id, (err, state) =>
                                                callback(err, tools.formatAliasValue(sourceObj, obj, state)));
                                        });
                                    }
                                } else {
                                    logger.warn(this.namespace + ' ' + (err || `Alias ${id} has no target 6`));
                                    callback(err || `Alias ${id} has no target`);
                                }
                            });
                        } else {
                            if (this.oStates && this.oStates[id]) {
                                callback(null, this.oStates[id]);
                            } else {
                                this.states.getState(id, callback);
                            }
                        }
                    }
                });
            } else {
                if (id.startsWith(ALIAS_STARTS_WITH)) {
                    this.objects.getObject(id, options, (err, obj) => {
                        if (obj && obj.common && obj.common.alias && (obj.common.alias.id || obj.common.alias.val !== undefined)) {
                            this.objects.getObject(obj.common.alias.id, options, (err, sourceObj) => {
                                if (this.oStates && this.oStates[obj.common.alias.id]) {
                                    const state = JSON.parse(JSON.stringify(this.oStates[obj.common.alias.id]));
                                    callback(err, tools.formatAliasValue(sourceObj, obj, state));
                                } else {
                                    this.states.getState(obj.common.alias.id, (err, state) =>
                                        callback(err, tools.formatAliasValue(sourceObj, obj, state)));
                                }
                            });
                        } else {
                            logger.warn(this.namespace + ' ' + (err || `Alias ${id} has no target 7`));
                            callback(err || `Alias ${id} has no target`);
                        }
                    });
                } else {
                    if (this.oStates && this.oStates[id]) {
                        callback(null, this.oStates[id]);
                    } else {
                        this.states.getState(id, callback);
                    }
                }
            }
        };
        /**
         * Promise-version of Adapter.getState
         */
        this.getStateAsync = tools.promisify(this.getState, this);

        /**
         * Read value from states DB for any instance and system state.
         *
         * This function can read values from states DB for all instances and adapters. It expects the full path of object ID.
         *
         * @alias getForeignState
         * @memberof Adapter
         * @param {string} id object ID of the state.
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            function (err, state) {
         *              if (err) adapter.log.error('Cannot read value: ' + err);
         *            }
         *        </code></pre>
         *
         *        See possible attributes of the state in @setState explanation
         */
        this.getForeignState = (id, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }

            if (typeof callback !== 'function') {
                return;
            }

            if (options && options.user && options.user !== 'system.user.admin') {
                checkStates(id, options, 'getState', (err, obj) => {
                    if (err) {
                        callback(err);
                    } else {
                        if (id.startsWith(ALIAS_STARTS_WITH)) {
                            if (obj && obj.common && obj.common.alias && (obj.common.alias.id || obj.common.alias.val !== undefined)) {
                                if (obj.common.alias.id)
                                    if (this.oStates && this.oStates[obj.common.alias.id]) {
                                        checkStates(obj.common.alias.id, options, 'getState', (err, sourceObj) => {
                                            if (err) {
                                                callback(err);
                                            } else {
                                                const state = JSON.parse(JSON.stringify(this.oStates[obj.common.alias.id]));
                                                callback(err, tools.formatAliasValue(sourceObj, obj, state));
                                            }
                                        });
                                    } else {
                                        checkStates(obj.common.alias.id, options, 'getState', (err, sourceObj) => {
                                            if (err) {
                                                callback(err);
                                            } else {
                                                this.inputCount++;
                                                this.states.getState(obj.common.alias.id, (err, state) =>
                                                    callback(err, tools.formatAliasValue(sourceObj, obj, state)));
                                            }
                                        });
                                    }
                            } else {
                                logger.warn(this.namespace + ' ' + (err || `Alias ${id} has no target 8`));
                                callback(err || `Alias ${id} has no target`);
                            }
                        } else {
                            if (this.oStates && this.oStates[id]) {
                                callback(null, this.oStates[id]);
                            } else {
                                this.states.getState(id, callback);
                            }
                        }
                    }
                });
            } else {
                if (id.startsWith(ALIAS_STARTS_WITH)) {
                    this.objects.getObject(id, (err, obj) => {
                        if (obj && obj.common && obj.common.alias && (obj.common.alias.id || obj.common.alias.val !== undefined)) {
                            this.objects.getObject(obj.common.alias.id, (err, sourceObj) => {
                                if (err) {
                                    return callback(err);
                                }
                                if (this.oStates && this.oStates[obj.common.alias.id]) {
                                    const state = JSON.parse(JSON.stringify(this.oStates[obj.common.alias.id]));
                                    callback(err, tools.formatAliasValue(sourceObj, obj, state));
                                } else {
                                    this.inputCount++;
                                    this.states.getState(obj.common.alias.id, (err, state) =>
                                        callback(err, tools.formatAliasValue(sourceObj, obj, state)));
                                }
                            });
                        } else {
                            logger.warn(this.namespace + ' ' + (err || `Alias ${id} has no target 9`));
                            callback(err || `Alias ${id} has no target`);
                        }
                    });
                } else {
                    if (this.oStates && this.oStates[id]) {
                        callback(null, this.oStates[id]);
                    } else {
                        this.inputCount++;
                        this.states.getState(id, callback);
                    }
                }
            }
        };
        /**
         * Promise-version of Adapter.getForeignState
         */
        this.getForeignStateAsync = tools.promisify(this.getForeignState, this);

        /**
         * Read historian data for states of any instance or system state.
         *
         * This function can read values from history adapters like: history, sql, influxdb. It expects the full path of object ID.
         * Normally only foreign history has interest, so there is no getHistory and getForeignHistory
         *
         * Possible options:
         *
         *  - instance - (optional) name of instance, where to read the historian data, e.g. 'history.0', 'sql.1'. By default will be taken from system settings.
         *  - start - (optional) time in ms - Date.now()', by default is (now - 1 week)
         *  - end - (optional) time in ms - Date.now()', by default is (now + 5000 seconds)
         *  - step - (optional) used in aggregate (m4, max, min, average, total) step in ms of intervals
         *  - count - number of values if aggregate is 'onchange' or number of intervals if other aggregate method. Count will be ignored if step is set.
         *  - from - if from field should be included in answer
         *  - ack - if ack field should be included in answer
         *  - q - if q field should be included in answer
         *  - addId - if id field should be included in answer
         *  - limit - do not return more entries than limit
         *  - ignoreNull - if null values should be include (false), replaced by last not null value (true) or replaced with 0 (0)
         *  - sessionId - (optional) identifier of request, will be returned back in the answer
         *  - aggregate - aggregate method:
         *      - minmax - used special algorithm. Splice the whole time range in small intervals and find for every interval max, min, start and end values.
         *      - max - Splice the whole time range in small intervals and find for every interval max value and use it for this interval (nulls will be ignored).
         *      - min - Same as max, but take minimal value.
         *      - average - Same as max, but take average value.
         *      - total - Same as max, but calculate total value.
         *      - count - Same as max, but calculate number of values (nulls will be calculated).
         *      - none - No aggregation at all. Only raw values in given period.
         *
         * @alias getHistory
         * @memberof Adapter
         * @param {string} id object ID of the state.
         * @param {object} options see function description
         * @param {function} callback return result
         *        <pre><code>
         *            function (error, result, step, sessionId) {
         *              if (error) adapter.log.error('Cannot read value: ' + err);
         *            }
         *        </code></pre>
         *
         *        See possible attributes of the state in @setState explanation
         */
        this.getHistory = (id, options, callback) => {
            options = options || {};
            options.end = options.end || Date.now() + 5000000;
            if (!options.count && !options.start) {
                options.start = options.start || Date.now() - 604800000; // - 1 week
            }

            if (!options.instance) {
                if (!this.defaultHistory) {
                    // read default history instance from system.config
                    return getDefaultHistory(() => this.getHistory(id, options, callback));
                } else {
                    options.instance = this.defaultHistory;
                }
            }

            this.sendTo(options.instance || 'history.0', 'getHistory', {id: id, options: options}, res => {
                setImmediate(() => callback(res.error, res.result, res.step, res.sessionId));
            });
        };
        /**
         * Promise-version of Adapter.getHistory
         */
        this.getHistoryAsync = tools.promisify(this.getHistory, this, ['result', 'step', 'sessionId']);

        /**
         * Convert ID into object with device's, channel's and state's name.
         *
         * Convert "adapter.instance.D.C.S" in object {device: D, channel: C, state: S}
         * Convert ID to {device: D, channel: C, state: S}
         *
         * @alias idToDCS
         * @memberof Adapter
         * @param {string} id short or long string of ID like "stateID" or "adapterName.0.stateID".
         * @return {object} parsed ID as an object
         */
        this.idToDCS = (id) => {
            if (!id) return null;
            const parts = id.split('.');
            if (parts[0] + '.' + parts[1] !== this.namespace) {
                logger.warn(this.namespace + ' Try to decode id not from this adapter');
                return null;
            }
            return {device: parts[2], channel: parts[3], state: parts[4]};
        };

        /**
         * Deletes a state of this instance.
         * The object will NOT be deleted. If you want to delete it too, use @delObject instead.
         *
         * It is not required to provice the adapter namespace, because it will automatically be added.
         * E.g. to delete "adapterName.X.myObject", only "myObject" is required as ID.
         *
         * No error is returned if state does not exist.
         *
         * @alias delState
         * @memberof Adapter
         * @param {string} id exactly object ID (without namespace)
         * @param {object} options optional user context
         * @param {function} callback return result
         *        <pre><code>
         *            function (err) {
         *              if (err) adapter.log.error('Cannot delete object: ' + err);
         *            }
         *        </code></pre>
         */
        this.delState = (id, options, callback) => {
            // delState does the same as delForeignState, but fixes the ID first
            id = this._fixId(id);
            this.delForeignState(id, options, callback);
        };
        /**
         * Promise-version of Adapter.delState
         */
        this.delStateAsync = tools.promisify(this.delState, this);

        /**
         * Deletes a state of any adapter.
         * The object is NOT deleted. If you want to delete it too, use @delForeignObject instead.
         *
         * No error is returned if state does not exist.
         *
         * @alias delForeignState
         * @memberof Adapter
         * @param {string} id long string for ID like "adapterName.0.stateID".
         * @param {object} options optional argument to describe the user context
         * @param {function} callback return result function (err) {}
         */
        this.delForeignState = (id, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }
            if (options && options.user && options.user !== 'system.user.admin') {
                checkStates(id, options, 'delState', err => {
                    if (err) {
                        typeof callback === 'function' && callback(err);
                    } else {
                        this.states.delState(id, callback);
                    }
                });
            } else {
                this.states.delState(id, callback);
            }
        };
        /**
         * Promise-version of Adapter.delForeignState
         */
        this.delForeignStateAsync = tools.promisify(this.delForeignState, this);

        /**
         * Read all states of this adapter, that pass the pattern
         *
         * Allows to read all states of current adapter according to pattern. To read all states of current adapter use:
         * <pre><code>
         *     adapter.getStates('*', function (err, states) {
         *         for (var id in states) {
         *              adapter.log.debug('"' + id + '" = "' + states[id].val);
         *         }
         *     });
         * </code></pre>
         *
         * @alias getStates
         * @memberof Adapter
         * @param {string} pattern string in form 'adapter.0.*' or like this. It can be array of IDs too.
         * @param {object} options optional argument to describe the user context
         * @param {function} callback return result function (err, states) {}, where states is an object like {"ID1": {"val": 1, "ack": true}, "ID2": {"val": 2, "ack": false}, ...}
         */
        this.getStates = (pattern, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }
            pattern = this._fixId(pattern, true, 'state');
            this.getForeignStates(pattern, options, callback);
        };
        /**
         * Promise-version of Adapter.getStates
         */
        this.getStatesAsync = tools.promisify(this.getStates, this);

        this._processStatesSecondary = function (keys, targetObjs, srcObjs, callback) {
            this.states.getStates(keys, (err, arr) => {
                if (err) {
                    return callback(err);
                }

                const result = {};

                for (let i = 0; i < keys.length; i++) {
                    const obj = targetObjs && targetObjs[i];
                    if (typeof arr[i] === 'string') {
                        try {
                            arr[i] = JSON.parse(arr[i]);
                        } catch (e) {
                            // if it is not binary state
                            if (arr[i] < 2000) {
                                logger.error(this.namespace + ' Cannot parse state "' + keys[i] + ': ' + arr[i]);
                            }
                        }
                    }

                    if (obj && obj.common && obj.common.alias) {
                        if (obj.common.alias.val !== undefined) {
                            result[obj._id] = obj.common.alias.val;
                        } else {
                            result[obj._id] = tools.formatAliasValue(srcObjs[i], obj, arr[i] || null);
                        }
                    } else {
                        result[keys[i]] = arr[i] || null;
                    }
                }
                callback(null, result);
            });
        };

        this._processStates = function (keys, targetObjs, callback) {
            let aliasFound;
            const aIds = keys.map(id => {
                if (id.startsWith(ALIAS_STARTS_WITH)) {
                    aliasFound = true;
                    return id;
                } else {
                    return null;
                }
            });

            // if any ID from aliases found
            if (aliasFound) {
                // read aliases objects
                this._getObjectsByArray(aIds, targetObjs, options, (errors, targetObjs) => {
                    const srcIds  = [];
                    // replace aliases ID with targets
                    targetObjs.forEach((obj, i) => {
                        if (obj && obj.common && obj.common.alias) {
                            keys[i]   = obj.common.alias.id || null;
                            srcIds[i] = keys[i];
                        }
                    });

                    // srcObjs and targetObjs could be merged
                    this._getObjectsByArray(srcIds, null, options, (errors, srcObjs) =>
                        this._processStatesSecondary(keys, targetObjs, srcObjs, callback));
                });
            } else {
                this._processStatesSecondary(keys, null, null, callback);
            }
        };

        /**
         * Read all states of all adapters (and system states), that pass the pattern
         *
         * Allows to read all states of current adapter according to pattern. To read all states of current adapter use:
         * <pre><code>
         *     adapter.getStates('*', function (err, states) {
         *         for (var id in states) {
         *              adapter.log.debug('"' + id + '" = "' + states[id].val);
         *         }
         *     });
         * </code></pre>
         *
         * @alias getForeignStates
         * @memberof Adapter
         * @param {string} pattern string in form 'adapter.0.*' or like this. It can be array of IDs too.
         * @param {object} options optional argument to describe the user context
         * @param {function} callback return result function (err, states) {}, where states is an object like {"ID1": {"val": 1, "ack": true}, "ID2": {"val": 2, "ack": false}, ...}
         */
        this.getForeignStates = (pattern, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }
            if (typeof pattern === 'function') {
                callback = pattern;
                pattern = '*';
            }

            if (typeof callback !== 'function') {
                return logger.error(this.namespace + ' getForeignStates invalid callback for ' + pattern);
            }

            // if pattern is array
            if (pattern instanceof Array) {
                if (options && options.user && options.user !== 'system.user.admin') {
                    checkStates(pattern, options, 'getState', (err, keys, objs) => {
                        if (err) {
                            return callback(err);
                        } else {
                            this._processStates(keys, objs, callback);
                        }
                    });
                } else {
                    this._processStates(pattern, null, callback);
                }
            } else {
                // read first the keys for pattern
                let params = {};
                if (pattern && pattern !== '*') {
                    params = {
                        startkey: pattern.replace(/\*/g, ''),
                        endkey:   pattern.replace(/\*/g, '\u9999')
                    };
                }
                let originalChecked = undefined;
                if (options.checked !== undefined) {
                    originalChecked = options.checked;
                }
                options.checked = true;

                this.objects.getObjectView('system', 'state', params, options, (err, res) => {
                    if (originalChecked !== undefined) {
                        options.checked = originalChecked;
                    } else {
                        options.checked = undefined;
                    }
                    if (err) {
                        return callback(err);
                    }
                    const keys = [];
                    const objs = [];

                    // filter out
                    let regEx;
                    // process patterns like "*.someValue". The patterns "someValue.*" will be processed by getObjectView
                    if (pattern && pattern !== '*' && pattern[pattern.length - 1] !== '*') {
                        regEx = new RegExp(pattern2RegEx(pattern));
                    }
                    for (let i = 0; i < res.rows.length; i++) {
                        if (!regEx || regEx.test(res.rows[i].id)) {
                            keys.push(res.rows[i].id);
                            objs.push(res.rows[i].value);
                        }
                    }
                    options._objects = objs;
                    this.getForeignStates(keys, options, callback);
                });
            }
        };
        /**
         * Promise-version of Adapter.getForeignStates
         */
        this.getForeignStatesAsync = tools.promisify(this.getForeignStates, this);

        /**
         * Subscribe for changes on all states of all adapters (and system states), that pass the pattern
         *
         * Allows to Subscribe on changes all states of all instances according to pattern. E.g. to read all states of 'adapterName.X' instance use:
         * <pre><code>
         *     adapter.subscribeForeignStates('adapterName.X.*');
         * </code></pre>
         *
         * @alias subscribeForeignStates
         * @memberof Adapter
         * @param {string} pattern string in form 'adapter.0.*' or like this. It can be array of IDs too.
         * @param {object} options optional argument to describe the user context
         * @param {function} callback return result function (err) {}
         */
        this.subscribeForeignStates = (pattern, options, callback) => {
            pattern = pattern || '*';
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }

            // Todo check rights for options
            autoSubscribeOn(() => {
                // compare if this pattern for one of auto-subscribe adapters
                for (let s = 0; s < this.autoSubscribe.length; s++) {
                    if (pattern === '*' || pattern.substring(0, this.autoSubscribe[s].length + 1) === this.autoSubscribe[s] + '.') {
                        // put this pattern into adapter list
                        this.states.getState('system.adapter.' + this.autoSubscribe[s] + '.subscribes', (err, state) => {
                            state = {};
                            state.val = state.val || '{}';
                            let subs;
                            try {
                                subs = JSON.parse(state.val);
                            } catch (e) {
                                logger.error(this.namespace + ' Cannot parse subscribes for "' + this.autoSubscribe[s] + '.subscribes"');
                            }
                            subs[pattern] = subs[pattern] || {};
                            subs[pattern][this.namespace] = subs[pattern][this.namespace] || 0;
                            subs[pattern][this.namespace]++;
                            this.outputCount++;
                            this.states.setState('system.adapter.' + this.autoSubscribe[s] + '.subscribes', subs);
                        });
                    }
                }

                if (pattern instanceof Array) {
                    let aliasesFound;
                    const ids = pattern.map(id => {
                        if (id.startsWith(ALIAS_STARTS_WITH)) {
                            aliasesFound = true;
                            return id;
                        } else {
                            return null;
                        }
                    });

                    if (aliasesFound) {
                        if (!this._aliasObjectsSubscribed) {
                            this._aliasObjectsSubscribed = true;
                            this.objects.subscribe(ALIAS_STARTS_WITH + '*');
                        }

                        this._getObjectsByArray(ids, null, options, (errors, targetObjs) => {
                            const sourcesIds = [];
                            let count = 0;
                            pattern.forEach((id, i) => {
                                if (ids[i]) {
                                    const obj = targetObjs[i];
                                    if (obj && obj.common && obj.common.alias && obj.common.alias.id) {
                                        sourcesIds.push(obj.common.alias.id);
                                        this.aliases[obj.common.alias.id] = JSON.parse(JSON.stringify(obj.common.alias));
                                        this.aliases[obj.common.alias.id].pattern = JSON.stringify(pattern);
                                        this.aliases[obj.common.alias.id].target = {common: obj.common};
                                        this.aliases[obj.common.alias.id].sourceId = obj._id;

                                        // may be call here subscribeForeignStates because of auto-subscribe
                                        count++;
                                        this.states.subscribe(obj.common.alias.id, () => {
                                            if (!--count) {
                                                this._getObjectsByArray(sourcesIds, null, options, (errors, srcObjs) => {
                                                    srcObjs.forEach(obj => {
                                                        if (obj && obj.common) {
                                                            this.aliases[obj._id].source = {common: obj.common};
                                                        }
                                                    });
                                                    typeof callback === 'function' && callback();
                                                });
                                            }
                                        });
                                    } else {
                                        logger.warn(`${this.namespace} Alias ${obj._id} has no target 10`);
                                    }
                                } else {
                                    this.states.subscribe(id);
                                }
                            });

                            !count && typeof callback === 'function' && callback();
                        });
                    } else {
                        this.states.subscribe(pattern, callback);
                    }
                } else if (pattern.includes('*')) {
                    if (pattern === '*' || pattern.startsWith(ALIAS_STARTS_WITH)) {
                        if (!this._aliasObjectsSubscribed) {
                            this._aliasObjectsSubscribed = true;
                            this.objects.subscribe(ALIAS_STARTS_WITH + '*');
                        }

                        // read all aliases
                        this.getForeignObjects(pattern, null, null, options, (err, objs) => {
                            const sourcesIds = [];
                            let count = 0;
                            Object.keys(objs).forEach(id => {
                                const obj = objs[id];

                                // If alias
                                if (id.startsWith(ALIAS_STARTS_WITH)) {
                                    // fill all required for that information
                                    if (obj && obj.common && obj.common.alias && obj.common.alias.id) {
                                        sourcesIds.push(obj.common.alias.id);
                                        this.aliases[obj.common.alias.id] = JSON.parse(JSON.stringify(obj.common.alias));
                                        this.aliases[obj.common.alias.id].pattern = JSON.stringify(pattern);
                                        this.aliases[obj.common.alias.id].target = {common: obj.common};
                                        this.aliases[obj.common.alias.id].sourceId = id;

                                        // Do this step only no global subscription will be done
                                        if (pattern !== '*') {
                                            count++;
                                            this.states.subscribe(obj.common.alias.id, () => {
                                                if (!--count) {
                                                    this._getObjectsByArray(sourcesIds, null, options, (errors, srcObjs) => {
                                                        srcObjs.forEach(obj => {
                                                            if (obj && obj.common) {
                                                                this.aliases[obj._id].source = {common: obj.common};
                                                            }
                                                        });
                                                        if (!pattern.startsWith(ALIAS_STARTS_WITH)) {
                                                            this.states.subscribe(pattern, callback);
                                                        } else {
                                                            typeof callback === 'function' && callback();
                                                        }
                                                    });
                                                }
                                            });
                                        }
                                    } else {
                                        logger.warn(err || `Alias ${id} has no target 11`);
                                    }
                                }
                            });

                            // no alias objects found
                            if (!count) {
                                this._getObjectsByArray(sourcesIds, null, options, (errors, srcObjs) => {
                                    srcObjs.forEach(obj => {
                                        if (obj && obj.common) {
                                            this.aliases[obj._id].source = {common: obj.common};
                                        }
                                    });

                                    if (pattern === '*') {
                                        this.states.subscribe(pattern, callback);
                                    } else {
                                        typeof callback === 'function' && callback();
                                    }
                                });
                            }
                        });
                    } else {
                        this.states.subscribe(pattern, callback);
                    }
                } else if (pattern.startsWith(ALIAS_STARTS_WITH)) {
                    if (!this._aliasObjectsSubscribed) {
                        this._aliasObjectsSubscribed = true;
                        this.objects.subscribe(ALIAS_STARTS_WITH + '*');
                    }
                    // just read one Object
                    this.objects.getObject(pattern, options, (err, obj) => {
                        let sourceIds;
                        if (obj && obj.common && obj.common.alias && obj.common.alias.id) {
                            sourceIds = obj.common.alias.id;
                            this.aliases[obj.common.alias.id] = JSON.parse(JSON.stringify(obj.common.alias));
                            this.aliases[obj.common.alias.id].pattern = JSON.stringify(pattern);
                            this.aliases[obj.common.alias.id].target = {common: obj.common};
                            this.aliases[obj.common.alias.id].sourceId = pattern;
                            this.states.subscribe(obj.common.alias.id, () =>
                                this.objects.getObject(sourceIds, options, (err, obj) => {
                                    if (obj && obj.common) {
                                        this.aliases[obj._id].source = {common: obj.common};
                                    }
                                    typeof callback === 'function' && callback(err);
                                }));
                        } else {
                            logger.warn(this.namespace + ' ' + (err || `Alias ${pattern} has no target 12`));
                            typeof callback === 'function' && callback();
                        }
                    });
                } else {
                    this.states.subscribe(pattern, callback);
                }
            });
        };
        /**
         * Promise-version of Adapter.subscribeForeignStates
         */
        this.subscribeForeignStatesAsync = tools.promisify(this.subscribeForeignStates, this);

        /**
         * Unsubscribe for changes for given pattern
         *
         * This function allows to unsubsrcibe from changes. The pattern must be equal to requested one.
         *
         * <pre><code>
         *     adapter.subscribeForeignStates('adapterName.X.*');
         *     adapter.unsubscribeForeignStates('adapterName.X.abc*'); // This will not work
         *     adapter.unsubscribeForeignStates('adapterName.X.*'); // Valid unsubscribe
         * </code></pre>
         *
         * @alias unsubscribeForeignStates
         * @memberof Adapter
         * @param {string} pattern string in form 'adapter.0.*'. Must be the same as subscribe.
         * @param {object} options optional argument to describe the user context
         * @param {function} callback return result function (err) {}
         */
        this.unsubscribeForeignStates = (pattern, options, callback) => {
            if (!pattern) pattern = '*';

            if (!this.states) { // if states is no longer existing, we do not need to unsubscribe
                callback && callback(new Error('States database not connected'));
                return;
            }
            // Todo check rights for options
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }

            if (this.autoSubscribe) {
                for (let s = 0; s < this.autoSubscribe.length; s++) {
                    if (pattern === '*' || pattern.substring(0, this.autoSubscribe[s].length + 1) === this.autoSubscribe[s] + '.') {
                        // remove this pattern from adapter list
                        this.states.getState('system.adapter.' + this.autoSubscribe[s] + '.subscribes', (err, state) => {
                            if (!state || !state.val) return;
                            let subs;
                            try {
                                subs = JSON.parse(state.val);
                            } catch (e) {
                                logger.error(this.namespace + ' Cannot parse subscribes for "' + this.autoSubscribe[s] + '.subscribes"');
                                return;
                            }
                            if (!subs[pattern]) return;
                            if (subs[pattern][this.namespace] === undefined) return;
                            subs[pattern][this.namespace]--;
                            if (subs[pattern][this.namespace] <= 0) delete subs[pattern][this.namespace];
                            let found = false;
                            // if any other subs are there
                            for (const id in subs[pattern]) {
                                if (subs[pattern].hasOwnProperty(id)) {
                                    found = true;
                                    break;
                                }
                            }
                            if (!found) delete subs[pattern];
                            this.outputCount++;
                            this.states.setState('system.adapter.' + this.autoSubscribe[s] + '.subscribes', subs);
                        });
                    }
                }
            }

            if (pattern instanceof Array) {
                if (pattern.find(id => id.startsWith(ALIAS_STARTS_WITH))) {
                    let count = 0;
                    const jsonPattern = JSON.stringify(pattern);

                    Object.keys(this.aliases).forEach(id => {
                        if (this.aliases[id].pattern === jsonPattern) {
                            count++;
                            this.states.unsubscribe(id, () =>
                                !--count && typeof callback === 'function' && callback());
                            delete this.aliases[id];
                        }
                    });
                    pattern.forEach(id => {
                        if (!id.startsWith(ALIAS_STARTS_WITH)) {
                            count++;
                            this.states.unsubscribe(id, () =>
                                !--count && typeof callback === 'function' && callback());
                        }
                    });

                    if (!Object.keys(this.aliases).length) {
                        if (this._aliasObjectsSubscribed) {
                            this._aliasObjectsSubscribed = false;
                            this.unsubscribeForeignObjects(ALIAS_STARTS_WITH + '*');
                        }
                    }

                    !count && typeof callback === 'function' && callback();
                } else {
                    this.states.unsubscribe(pattern, callback);
                }
            } else if (pattern === '*' || pattern.startsWith(ALIAS_STARTS_WITH)) {
                const jsonPattern = JSON.stringify(pattern);
                let count = 0;

                Object.keys(this.aliases).forEach(id => {
                    if (this.aliases[id].pattern === jsonPattern) {

                        // Un-subscribe each alias apart
                        if (pattern !== '*') {
                            count++;
                            this.states.unsubscribe(id, () =>
                                !--count && typeof callback === 'function' && callback());
                        }
                        delete this.aliases[id];
                    }
                });

                if (!Object.keys(this.aliases).length) {
                    if (this._aliasObjectsSubscribed) {
                        this._aliasObjectsSubscribed = false;
                        this.unsubscribeForeignObjects(ALIAS_STARTS_WITH + '*');
                    }
                }

                if (!count) {
                    if (pattern === '*') {
                        this.states.unsubscribe(pattern, callback);
                    } else {
                        typeof callback === 'function' && callback();
                    }
                }
            } else {
                this.states.unsubscribe(pattern, callback);
            }
        };
        /**
         * Promise-version of Adapter.unsubscribeForeignStates
         */
        this.unsubscribeForeignStatesAsync = tools.promisify(this.unsubscribeForeignStates, this);

        /**
         * Subscribe for changes on all states of this instance, that pass the pattern
         *
         * Allows to Subscribe on changes all states of current adapter according to pattern. To read all states of current adapter use:
         * <pre><code>
         *     adapter.subscribeStates('*'); // subscribe for all states of this adapter
         * </code></pre>
         *
         * @alias subscribeStates
         * @memberof Adapter
         * @param {string} pattern string in form 'adapter.0.*' or like this. It can be array of IDs too.
         * @param {object} options optional argument to describe the user context
         * @param {function} callback return result function (err) {}
         */
        this.subscribeStates = (pattern, options, callback) => {
            // Todo check rights for options
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }

            // Exception. Threat the '*' case automatically
            if (!pattern || pattern === '*') {
                this.states.subscribe(this.namespace + '.*', callback);
            } else {
                pattern = this._fixId(pattern, true, 'state');
                this.states.subscribe(pattern, callback);
            }
        };
        /**
         * Promise-version of Adapter.subscribeStates
         */
        this.subscribeStatesAsync = tools.promisify(this.subscribeStates, this);

        /**
         * Unsubscribe for changes for given pattern for own states.
         *
         * This function allows to unsubsrcibe from changes. The pattern must be equal to requested one.
         *
         * <pre><code>
         *     adapter.subscribeForeignStates('*');
         *     adapter.unsubscribeForeignStates('abc*'); // This will not work
         *     adapter.unsubscribeForeignStates('*');    // Valid unsubscribe
         * </code></pre>
         *
         * @alias unsubscribeStates
         * @memberof Adapter
         * @param {string} pattern string in form 'adapter.0.*'. Must be the same as subscribe.
         * @param {object} options optional argument to describe the user context
         * @param {function} callback return result function (err) {}
         */
        this.unsubscribeStates = (pattern, options, callback) => {
            if (!this.states) { // if states is no longer existing, we do not need to unsubscribe
                callback && callback(new Error('States database not connected'));
                return;
            }
            // Todo check rights for options
            if (typeof options === 'function') {
                callback = options;
                options = null;
            }

            if (!pattern || pattern === '*') {
                this.states.unsubscribe(this.namespace + '.*', callback);
            } else {
                pattern = this._fixId(pattern, true, 'state');
                this.states.unsubscribe(pattern, callback);
            }
        };
        /**
         * Promise-version of Adapter.unsubscribeStates
         */
        this.unsubscribeStatesAsync = tools.promisify(this.unsubscribeStates, this);

        this.pushFifo = (id, state, callback) => {
            this.states.pushFifo(id, state, callback);
        };

        this.trimFifo = (id, start, end, callback) => {
            this.states.trimFifo(id, start, end, callback);
        };

        this.getFifoRange = (id, start, end, callback) => {
            this.states.getFifoRange(id, start, end, callback);
        };

        this.getFifo = (id, callback) => {
            this.states.getFifo(id, callback);
        };

        this.lenFifo = (id, callback) => {
            this.states.lenFifo(id, callback);
        };

        this.subscribeFifo = (pattern) => {
            this.states.subscribeFifo(pattern);
        };

        this.getSession = (id, callback) => {
            this.states.getSession(id, callback);
        };

        this.setSession = (id, ttl, data, callback) => {
            this.states.setSession(id, ttl, data, callback);
        };

        this.destroySession = (id, callback) => {
            this.states.destroySession(id, callback);
        };

        this.getMessage = (callback) => {
            this.states.getMessage('system.adapter.' + this.namespace, callback);
        };

        this.lenMessage = (callback) => {
            this.states.lenMessage('system.adapter.' + this.namespace, callback);
        };

        /**
         * Write binary block into redis, e.g image
         *
         * @alias setBinaryState
         * @memberof Adapter
         *
         * @param {string} id of state
         * @param {Buffer} binary data
         * @param {object} options optional
         * @param {function} callback
         *
         */
        this.setBinaryState = (id, binary, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }
            if (options && options.user && options.user !== 'system.user.admin') {
                checkStates(id, options, 'setState', err => {
                    if (err) {
                        typeof callback === 'function' && callback(err);
                    } else {
                        this.states.setBinaryState(id, binary, callback);
                    }
                });
            } else {
                this.states.setBinaryState(id, binary, callback);
            }
        };
        /**
         * Promise-version of Adapter.setBinaryState
         *
         * @alias setBinaryStateAsync
         * @memberof Adapter
         * @param {string} id of state
         * @param {Buffer} binary data
         * @param {object} options optional
         * @return promise
         *
         */
        this.setBinaryStateAsync = tools.promisify(this.setBinaryState, this);

        // Read binary block from redis, e.g. image
        this.getBinaryState = (id, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }
            if (options && options.user && options.user !== 'system.user.admin') {
                checkStates(id, options, 'getState', err => {
                    if (err) {
                        typeof callback === 'function' && callback(err);
                    } else {
                        this.states.getBinaryState(id, callback);
                    }
                });
            } else {
                this.states.getBinaryState(id, callback);
            }
        };
        /**
         * Promise-version of Adapter.getBinaryState
         *
         * @alias getBinaryStateAsync
         * @memberof Adapter
         *
         */
        this.getBinaryStateAsync = tools.promisify(this.getBinaryState, this);

        /**
         * Deletes binary state
         *
         * @alias delBinaryState
         * @memberof Adapter
         *
         * @param {string} id
         * @param {object} options optional
         * @param {function} callback optional
         *
         */
        this.delBinaryState = (id, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }
            if (options && options.user && options.user !== 'system.user.admin') {
                checkStates(id, options, 'delState', err => {
                    if (err) {
                        typeof callback === 'function' && callback(err);
                    } else {
                        this.states.delBinaryState(id, callback);
                    }
                });
            } else {
                this.states.delBinaryState(id, callback);
            }
        };

        /**
         * Promise-version of Adapter.delBinaryState
         *
         * @alias delBinaryStateAsync
         * @memberof Adapter
         * @param {string} id
         * @param {object} options optional
         * @return promise
         *
         */
        this.delBinaryStateAsync = tools.promisify(this.delBinaryState, this);
    };

    // read all logs prepared for this adapter at start
    const readLogs = (callback) => {
        // read all stored messages
        this.states.getLog('system.adapter.' + this.namespace, (err, msg) => {
            if (msg) {
                this.emit('log', msg);
                setImmediate(() => readLogs(callback));
            } else if (typeof callback === 'function') {
                callback();
            }
        });
    };

    // debug function to find error with stop logging
    const checkLogging = () => {
        let logs  = [];
        // LogList
        logs.push('Actual Loglist - ' + JSON.stringify(this.logList));

        // Read current state of all log subscribers
        this.states.getKeys('*.logging', (err, keys) => {
            if (keys && keys.length) {
                this.states.getStates(keys, (err, obj) => {
                    if (obj) {
                        for (let i = 0; i < keys.length; i++) {
                            // We can JSON.parse, but index is 16x faster
                            if (obj[i]) {
                                const id = keys[i].substring(0, keys[i].length - '.logging'.length);
                                if ((typeof obj[i] === 'string' && (obj[i].indexOf('"val":true') !== -1 || obj[i].indexOf('"val":"true"') !== -1)) ||
                                    (typeof obj[i] === 'object' && (obj[i].val === true || obj[i].val === 'true'))) {
                                    logs.push('Subscriber - ' + id + ' ENABLED');
                                } else {
                                    if (logs) {
                                        logs.push('Subscriber - ' + id + ' (disabled)');
                                    } else {
                                        logger.error(this.namespace + ' LOGINFO: Subscriber - ' + id + ' (disabled)');
                                    }
                                }
                            }
                        }
                    }
                    if (logs) {
                        for (let m = 0; m < logs.length; m++) {
                            logger.error(this.namespace + ' LOGINFO: ' + logs[m]);
                        }
                        logs = null;
                    }
                });
            }
        });
    };

    const initLogging = (callback) => {
        // temporary log buffer
        let messages = [];
        // Read current state of all log subscriber
        this.states.getKeys('*.logging', (err, keys) => {
            if (keys && keys.length) {
                this.states.getStates(keys, (err, obj) => {
                    if (obj) {
                        for (let i = 0; i < keys.length; i++) {
                            // We can JSON.parse, but index is 16x faster
                            if (!obj[i]) continue;
                            const id = keys[i].substring(0, keys[i].length - '.logging'.length);
                            if (typeof obj[i] === 'string' && (obj[i].indexOf('"val":true') !== -1 || obj[i].indexOf('"val":"true"') !== -1)) {
                                this.logRedirect(true, id);
                            } else if (typeof obj[i] === 'object' && (obj[i].val === true || obj[i].val === 'true')) {
                                this.logRedirect(true, id);
                            }
                        }
                        if (this.logList.length && messages && messages.length && this.states && this.states.pushLog) {
                            for (let m = 0; m < messages.length; m++) {
                                for (let k = 0; k < this.logList.length; k++) {
                                    this.states.pushLog(this.logList[k], messages[m]);
                                }
                            }
                        }
                    }
                    // clear log buffer
                    messages = null;
                });
            } else {
                // disable log buffer
                messages = null;
            }
            callback && callback();
        });

        this.logRedirect = (isActive, id) => {
            // ignore itself
            if (id === 'system.adapter.' + this.namespace) return;

            if (isActive) {
                if (this.logList.indexOf(id) === -1) this.logList.push(id);
            } else {
                const pos = this.logList.indexOf(id);
                if (pos !== -1) this.logList.splice(pos, 1);
            }
        };

        // If some message from logger
        // find our notifier transport
        const ts = logger.transports.find(t => t.name === 'NT');
        ts.on('logged', info => {
            info.from = this.namespace;
            // emit to itself
            if (options.logTransporter) {
                this.emit('log', info);
            }

            if (!this.logList.length) {
                // if log buffer still active
                if (messages && !options.logTransporter) {
                    messages.push(info);

                    // do not let messages to grow without limit
                    if (messages.length > config.states.maxQueue) {
                        messages.splice(0, messages.length - config.states.maxQueue);
                    }
                }
            } else if (this.states && this.states.pushLog) {
                // Send to all adapter, that required logs
                for (let i = 0; i < this.logList.length; i++) {
                    this.states.pushLog(this.logList[i], info);
                }
            }
        });

        options.logTransporter = options.logTransporter || this.ioPack.common.logTransporter;

        if (options.logTransporter) {
            this.requireLog = (isActive) => {
                if (this.states) {
                    if (this.logRequired !== isActive) {
                        this.logRequired = isActive; // remember state
                        if (!isActive) {
                            if (this.logOffTimer) {
                                clearTimeout(this.logOffTimer);
                            }
                            // disable log receiving after 10 seconds
                            this.logOffTimer = setTimeout(() => {
                                this.logOffTimer = null;
                                logger.debug(this.namespace + ' Change log subscriber state: FALSE');
                                this.outputCount++;
                                this.states.setState('system.adapter.' + this.namespace + '.logging', {val: false, ack: true, from: 'system.adapter.' + this.namespace});
                            }, 10000);
                        } else {
                            if (this.logOffTimer) {
                                clearTimeout(this.logOffTimer);
                                this.logOffTimer = null;
                            } else {
                                logger.debug(this.namespace + ' Change log subscriber state: true');
                                this.outputCount++;
                                this.states.setState('system.adapter.' + this.namespace + '.logging', {val: true, ack: true, from: 'system.adapter.' + this.namespace});
                            }
                        }
                    }
                }
            };

            this.processLog = msg => {
                msg && this.emit('log', msg);
                this.states && this.states.delLog && this.states.delLog('system.adapter.' + this.namespace, msg._id);
            };

            readLogs();

            this.states.subscribeLog('system.adapter.' + this.namespace);
        } else {
            this.requireLog = (_isActive) => {
                logger.warn(this.namespace + ' requireLog is not supported by this adapter! Please set common.logTransporter to true');
            };
        }
    };

    const initAdapter = (adapterConfig) => {
        initLogging(() => {
            if (options.instance === undefined) {
                if (!adapterConfig || !adapterConfig.common || !adapterConfig.common.enabled) {
                    if (adapterConfig && adapterConfig.common && adapterConfig.common.enabled !== undefined) {
                        !config.isInstall && logger.error(this.namespace + ' adapter disabled');
                    } else {
                        !config.isInstall && logger.error(this.namespace + ' no config found for adapter');
                    }

                    if (!config.isInstall && (!process.argv || !config.forceIfDisabled)) {
                        const id = 'system.adapter.' + this.namespace;
                        this.outputCount += 2;
                        this.states.setState(id + '.alive', {val: true, ack: true, expire: 30, from: id});
                        let done = false;
                        this.states.setState(id + '.connected', {val: true, ack: true, expire: 30, from: id}, () => {
                            if (!done) {
                                done = true;
                                this.terminate(EXIT_CODES.NO_ADAPTER_CONFIG_FOUND);
                            }
                        });
                        setTimeout(() => {
                            if (!done) {
                                done = true;
                                this.terminate(EXIT_CODES.NO_ADAPTER_CONFIG_FOUND);
                            }
                        }, 1000);
                        return;
                    }
                }

                if (!config.isInstall && !adapterConfig._id) {
                    logger.error(this.namespace + ' invalid config: no _id found');
                    this.terminate(EXIT_CODES.INVALID_ADAPTER_ID);
                    return;
                }

                let name;
                let instance;

                if (!config.isInstall) {
                    const tmp = adapterConfig._id.match(/^system\.adapter\.([a-zA-Z0-9-_]+)\.([0-9]+)$/);
                    if (!tmp) {
                        logger.error(this.namespace + ' invalid config');
                        this.terminate(EXIT_CODES.INVALID_ADAPTER_ID);
                        return;
                    }
                    name = tmp[1];
                    instance =  parseInt(tmp[2]) || 0;
                } else {
                    name = options.name;
                    instance = 0;
                    adapterConfig = adapterConfig || {common: {mode: 'once', name: name}, native: {}, protectedNative: []};
                }

                for (const tp in logger.transports) {
                    if (logger.transports.hasOwnProperty(tp)) {
                        logger.transports[tp].level = adapterConfig.common.logLevel || 'info';
                    }
                }

                this.name = adapterConfig.common.name;
                this.instance = instance;
                this.namespace = name + '.' + instance;
                if (!this.startedInCompactMode) {
                    process.title = 'io.' + this.namespace;
                }

                this.config = adapterConfig.native;
                this.host = adapterConfig.common.host;
                this.common = adapterConfig.common;

                if (adapterConfig.common.mode === 'subscribe' ||
                    adapterConfig.common.mode === 'schedule' ||
                    adapterConfig.common.mode === 'once') {
                    this.stop = () => stop(true);
                } else if (this.startedInCompactMode) {
                    this.stop = () => stop(false);
                    this.kill = this.stop;
                }

                // Monitor logging state
                this.states.subscribe('*.logging');

                if (typeof options.message === 'function' && !adapterConfig.common.messagebox) {
                    logger.error(this.namespace + ' : message handler implemented, but messagebox not enabled. Define common.messagebox in io-package.json for adapter or delete message handler.');
                } else if (/*typeof options.message === 'function' && */adapterConfig.common.messagebox) {
                    this.mboxSubscribed = true;
                    this.states.subscribeMessage('system.adapter.' + this.namespace);
                }

                // set configured in DB log level
                if (adapterConfig.common.loglevel) {
                    for (const trans in logger.transports) {
                        if (logger.transports.hasOwnProperty(trans)) {
                            logger.transports[trans].level = adapterConfig.common.loglevel;
                        }
                    }
                }
            } else {
                this.name = adapterConfig.name || options.name;
                this.instance = adapterConfig.instance || 0;
                this.namespace = this.name + '.' + this.instance;

                this.config = adapterConfig.native || {};
                this.common = adapterConfig.common || {};
                this.host = this.common.host || tools.getHostName() || os.hostname();
            }

            class Log {
                /**
                 * @param {Adapter} adapter The adapter instance
                 * @param {string} level The log level
                 */
                constructor(adapter, level) {
                    this.adapter = adapter;
                    this.level = level;
                    // We have to bind the this context here or it is possible that `this` is
                    // undefined when passing around the logger methods. This happens e.g. when doing this:
                    //   const log = new Log(...);
                    //   const test = log.info;
                    //   test();
                    this.silly = this.silly.bind(this);
                    this.debug = this.debug.bind(this);
                    this.info  = this.info.bind(this);
                    this.error = this.error.bind(this);
                    this.warn  = this.warn.bind(this);
                }
                silly(msg) {
                    logger.silly(this.adapter.namespace + ' ' + msg);
                }
                debug(msg) {
                    logger.debug(this.adapter.namespace + ' ' + msg);
                }
                info(msg) {
                    logger.info(this.adapter.namespace + ' ' + msg);
                }
                error(msg) {
                    logger.error(this.adapter.namespace + ' ' + msg);
                }
                warn(msg) {
                    logger.warn(this.adapter.namespace + ' ' + msg);
                }
            }

            this.log = new Log(this, config.log.level);

            // set current loglevel
            this.states.setState('system.adapter.' + this.namespace + '.logLevel', {val: config.log.level, ack: true, from: 'system.adapter.' + this.namespace});

            if (options.instance === undefined) {
                this.version = (this.pack && this.pack.version) ? this.pack.version : ((this.ioPack && this.ioPack.common) ? this.ioPack.common.version : 'unknown');

                logger.info(this.namespace + ' starting. Version ' + this.version + ' in ' + this.adapterDir + ', node: ' + process.version);
                config.system = config.system || {};
                config.system.statisticsInterval = parseInt(config.system.statisticsInterval, 10) || 15000;
                reportInterval = setInterval(reportStatus, config.system.statisticsInterval);
                reportStatus();
                const id = 'system.adapter.' + this.namespace;
                this.states.setState(id + '.compactMode', {ack: true, from: id, val: !!this.startedInCompactMode});
                this.outputCount++;
                if (this.startedInCompactMode) {
                    this.states.setState(id + '.cpu', {ack: true, from: id, val: 0});
                    this.states.setState(id + '.cputime', {ack: true, from: id, val: 0});
                    this.states.setState(id + '.memRss', {val: 0, ack: true, from: id});
                    this.states.setState(id + '.memHeapTotal', {val: 0, ack: true, from: id});
                    this.states.setState(id + '.memHeapUsed', {val: 0, ack: true, from: id});
                    this.states.setState(id + '.eventLoopLag', {val: 0, ack: true, from: id});
                    this.outputCount += 6;
                } else {
                    tools.measureEventLoopLag(1000, lag => this.eventLoopLags.push(lag));
                }
            }

            if (adapterConfig && adapterConfig.common && adapterConfig.common.restartSchedule) {
                try {
                    schedule = require('node-schedule');
                } catch (e) {
                    logger.error(this.namespace + ' Cannot load node-schedule. Scheduled restart is disabled');
                }
                if (schedule) {
                    logger.debug(this.namespace + ' Schedule restart: ' + adapterConfig.common.restartSchedule);
                    restartScheduleJob = schedule.scheduleJob(adapterConfig.common.restartSchedule, () => {
                        logger.info(this.namespace + ' Scheduled restart.');
                        stop(false, true);
                    });
                }
            }

            // auto oStates
            if (options.states) {
                this.getStates('*', null, (err, _states) => {
                    this.oStates = _states;
                    this.subscribeStates('*');
                    if (firstConnection) {
                        firstConnection = false;
                        if (typeof options.ready === 'function') options.ready();
                        this.emit('ready');
                    } else {
                        if (typeof options.reconnect === 'function') options.reconnect();
                        this.emit('reconnect');
                    }
                });
            } else {
                if (typeof options.ready === 'function') options.ready();
                this.emit('ready');

                // todo remove it later, when the error is fixed
                this.subscribeStates('checkLogging');
            }
        });
    };

    const reportStatus = () => {
        const id = 'system.adapter.' + this.namespace;
        this.states.setState(id + '.alive', {val: true, ack: true, expire: Math.floor(config.system.statisticsInterval / 1000) + 10, from: id});
        this.outputCount++;
        if (this.connected) {
            this.states.setState(id + '.connected', {val: true, ack: true, expire: 30, from: id});
            this.outputCount++;
        }
        if (!this.startedInCompactMode) {
            // pidUsage([pid,pid,...], function (err, stats) {
            // => {
            //   cpu: 10.0,            // percentage (from 0 to 100*vcore)
            //   memory: 357306368,    // bytes
            //   ppid: 312,            // PPID
            //   pid: 727,             // PID
            //   ctime: 867000,        // ms user + system time
            //   elapsed: 6650000,     // ms since the start of the process
            //   timestamp: 864000000  // ms since epoch
            // }
            pidUsage(process.pid, (err, stats) => {
                // sometimes adapter is stopped, but this is still running
                if (!err && this && this.states && this.states.setState && stats) {
                    this.states.setState(id + '.cpu', {ack: true, from: id, val: parseFloat(stats.cpu).toFixed(2)});
                    this.states.setState(id + '.cputime', {ack: true, from: id, val: stats.ctime / 1000});
                    this.outputCount += 2;
                }
            });
            //RSS is the resident set size, the portion of the process's memory held in RAM (as opposed to the swap space or the part held in the filesystem).
            const mem = process.memoryUsage();
            this.states.setState(id + '.memRss', {
                val: parseFloat((mem.rss / 1048576/* 1MB */).toFixed(2)),
                ack: true,
                from: id
            });
            this.states.setState(id + '.memHeapTotal', {
                val: parseFloat((mem.heapTotal / 1048576/* 1MB */).toFixed(2)),
                ack: true,
                from: id
            });
            this.states.setState(id + '.memHeapUsed', {
                val: parseFloat((mem.heapUsed / 1048576/* 1MB */).toFixed(2)),
                ack: true,
                from: id
            });
            this.outputCount += 3;
            if (this.eventLoopLags.length) {
                const eventLoopLag = Math.ceil(this.eventLoopLags.reduce((a, b) => (a + b)) / this.eventLoopLags.length);
                this.states.setState(id + '.eventLoopLag', {val: eventLoopLag, ack: true, from: id}); // average of measured values
                this.eventLoopLags = [];
                this.outputCount++;
            }
        }
        this.outputCount += 3;
        this.states.setState(id + '.uptime', {val: parseInt(process.uptime().toFixed(), 10), ack: true, from: id});
        this.states.setState(id + '.inputCount', {val: this.inputCount, ack: true, from: id});
        this.states.setState(id + '.outputCount', {val: this.outputCount, ack: true, from: id});
        this.inputCount  = 0;
        this.outputCount = 0;
    };

    const stop = (isPause, isScheduled) => {
        clearInterval(reportInterval);
        reportInterval = null;
        const id = 'system.adapter.' + this.namespace;

        const finishUnload = () => {
            if (this.states) {
                this.outputCount++;
                this.states.setState(id + '.alive', {val: false, ack: true, from: id}, () => {
                    if (!isPause && this.log) logger.info(this.namespace + ' terminating');
                    this.terminate(isScheduled ? EXIT_CODES.START_IMMEDIATELY_AFTER_STOP : 0);
                });
            }
        };

        if (typeof options.unload === 'function') {
            if (options.unload.length >= 1) {
                // The method takes (at least) a callback
                options.unload(finishUnload);
            } else {
                // The method takes no arguments, so it must return a Promise
                const unloadPromise = options.unload();
                if (unloadPromise instanceof Promise) {
                    // Call finishUnload in the case of success and failure
                    unloadPromise.then(finishUnload, finishUnload);
                } else {
                    // No callback accepted and no Promise returned - force unload
                    logger.error(`${this.namespace} Error in ${id}: The unload method must return a Promise if it does not accept a callback!`);
                }
            }
        } else {
            this.emit('unload', finishUnload);
        }

        // Even if the developer forgets to call the unload callback, we need to stop the process
        // Therefore wait a short while and then force the unload
        setTimeout(() => {
            if (this.states) {
                finishUnload();

                // Give 2 seconds to write the value
                setTimeout(() => {
                    if (!isPause && this.log) logger.info(this.namespace + ' terminating with timeout');
                    this.terminate(isScheduled ? EXIT_CODES.START_IMMEDIATELY_AFTER_STOP : 0);
                }, 1000);
            } else {
                if (!isPause && this.log) logger.info(this.namespace + ' terminating');
                this.terminate(isScheduled ? EXIT_CODES.START_IMMEDIATELY_AFTER_STOP : 0);
            }
        }, (this.common && this.common.stopTimeout) || 500);
    };

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    // And the exit event shuts down the child.
    process.once('exit', stop);

    process.on('uncaughtException', err => {

        // If the adapter has a callback to listen for unhandled errors
        // give it a chance to handle the error itself instead of restarting it
        if (typeof options.error === 'function') {
            try {
                // if error handler in the adapter returned exactly true,
                // we expect the error to be handled and do nothing more
                const wasHandled = options.error(err);
                if (wasHandled === true) return;
            } catch (e) {
                console.error(`Error in adapter error handler: ${e}`);
            }
        }

        console.error(err);

        // catch it on windows
        if (this.getPortRunning && err.message === 'listen EADDRINUSE') {
            logger.warn(this.namespace + ' Port ' + this.getPortRunning.port + (this.getPortRunning.host ? ' for host ' + this.getPortRunning.host : '') + ' is in use. Get next');

            setImmediate(() => this.getPort(this.getPortRunning.port + 1, this.getPortRunning.host, this.getPortRunning.callback));
            return;
        }

        logger.error(this.namespace + ' uncaught exception: ' + (err.message || err));
        if (err.stack) logger.error(this.namespace + ' ' + err.stack);

        try {
            stop();
            setTimeout(() => this.terminate(EXIT_CODES.UNCAUGHT_EXCEPTION), 1000);
        } catch (err) {
            logger.error(this.namespace + ' exception by stop: ' + (err.message || err));
        }
    });

    initObjects(() => {
        if (this.inited) {
            this.log && logger.warn(this.namespace + ' Reconnection to DB.');
            return;
        }

        this.inited = true;

        // auto oObjects
        if (options.objects) {
            this.getAdapterObjects(objs => {
                this.oObjects = objs;
                this.subscribeObjects('*');
                initStates(prepareInitAdapter);
            });
        } else {
            initStates(prepareInitAdapter);
        }
    });

    return this;
}

// extend the EventEmitter class using our class
util.inherits(Adapter, EventEmitter);

module.exports = Adapter;
