/**
 *      Backup
 *
 *      Copyright 2013-2019 bluefox <dogafox@gmail.com>
 *
 *      MIT License
 *
 */

'use strict';
const fs = require('fs');
const tools = require('../tools');
const pathLib = require('path');
const hostname = tools.getHostName();
const Upload = require('./setupUpload');
const EXIT_CODES = require('../exitCodes');

// We cannot use relative paths for the backup locations, as they used by both
// require, which resolves relative paths from __dirname
// and the fs methods, which resolve relative paths from process.cwd()
const tmpDir = pathLib.normalize(pathLib.join(__dirname, '../../tmp'));
const bkpDir = pathLib.normalize(pathLib.join(__dirname, '../../backups'));

class BackupRestore {
    constructor(options) {
        options = options || {};

        if (!options.states) throw 'Invalid arguments: states is missing';
        if (!options.objects) throw 'Invalid arguments: objects is missing';
        if (!options.processExit) throw 'Invalid arguments: processExit is missing';
        if (!options.cleanDatabase) throw 'Invalid arguments: cleanDatabase is missing';
        if (!options.restartController) throw 'Invalid arguments: restartController is missing';

        this.objects = options.objects;
        this.states = options.states;
        this.processExit = options.processExit;
        this.cleanDatabase = options.cleanDatabase;
        this.restartController = options.restartController;
        this.dbMigration = options.dbMigration || false;
        this.mime; // TODO: this is unused!

        this.upload = new Upload(options);

        this.configParts = tools.getConfigFileName().split('/');
        this.configParts.pop(); // remove *.json
        this.configDir = this.configParts.join('/'); // => name-data

        this.reloadAdapterObject = this.reloadAdapterObject.bind(this);
        this._setStateHelper = this._setStateHelper.bind(this);
        this._setObjHelper = this._setObjHelper.bind(this);
        this.reloadAdaptersObjects = this.reloadAdaptersObjects.bind(this);
    } // endConstructor

    // --------------------------------------- BACKUP ---------------------------------------------------
    _copyFile(id, srcPath, destPath, callback) {
        this.objects.readFile(id, srcPath, '', (err, data) => {
            if (data) fs.writeFileSync(destPath, data);
            setImmediate(callback);
        });
    }

    copyDir(id, srcPath, destPath, callback) {
        let count = 0;
        if (!fs.existsSync(destPath)) {
            fs.mkdirSync(destPath);
        }
        this.objects.readDir(id, srcPath, (err, res) => {
            if (res) {
                for (let t = 0; t < res.length; t++) {
                    if (res[t].isDir) {
                        count++;
                        this.copyDir(id, srcPath + '/' + res[t].file, destPath + '/' + res[t].file, () => {
                            if (!--count) {
                                setImmediate(callback);
                            }
                        });
                    } else {
                        if (!fs.existsSync(destPath)) {
                            fs.mkdirSync(destPath);
                        }
                        count++;
                        this._copyFile(id, srcPath + '/' + res[t].file, destPath + '/' + res[t].file, () => {
                            if (!--count) {
                                setImmediate(callback);
                            }
                        });
                    }
                }
            }
            if (!count) {
                setImmediate(callback);
            }
        });
    }

    _removeFolderRecursive(path) {
        return new Promise(resolve => {
            if(fs.existsSync(path) ) {
                fs.readdirSync(path).forEach(file => {
                    const curPath = path + '/' + file;
                    if(fs.statSync(curPath).isDirectory()) { // recurse
                        this._removeFolderRecursive(curPath);
                    } else { // delete file
                        fs.unlinkSync(curPath);
                    }
                });
                fs.rmdirSync(path);
            }
            resolve();
        });
    } // endRemoveFolderRecursive

    getBackupDir() {
        let dataDir = tools.getDefaultDataDir();

        // All paths are returned always relative to /node_modules/appName.js-controller
        if (dataDir) {
            if (dataDir[0] === '.' && dataDir[1] === '.') {
                dataDir = __dirname + '/../../' + dataDir;
            } else if (dataDir[0] === '.' && dataDir[1] === '/') {
                dataDir = __dirname + '/../../' + dataDir.substring(2);
            }
        }
        dataDir = dataDir.replace(/\\/g, '/');
        if (dataDir[dataDir.length - 1] !== '/') dataDir += '/';

        const parts = dataDir.split('/');
        parts.pop();// remove data or appName-data
        parts.pop();

        return parts.join('/') + '/backups/';
    }

    copyFileSync(source, target) {
        let targetFile = target;

        // if target is a directory a new file with the same name will be created
        if (fs.existsSync(target)) {
            if (fs.statSync(target).isDirectory()) {
                targetFile = pathLib.join(target, pathLib.basename(source));
            }
        }

        fs.writeFileSync(targetFile, fs.readFileSync(source));
    }

    copyFolderRecursiveSync(source, target) {
        let files = [];

        if (!fs.existsSync(target)) {
            fs.mkdirSync(target);
        }

        // check if folder needs to be created or integrated
        const targetFolder = pathLib.join(target, pathLib.basename(source));
        if (!fs.existsSync(targetFolder)) fs.mkdirSync(targetFolder);

        // copy
        if (fs.statSync(source).isDirectory()) {
            files = fs.readdirSync(source);
            files.forEach((file) => {
                const curSource = pathLib.join(source, file);
                if (fs.statSync(curSource).isDirectory()) {
                    this.copyFolderRecursiveSync(curSource, targetFolder);
                } else {
                    this.copyFileSync(curSource, targetFolder);
                }
            });
        }
    }

    packBackup(name, callback) {
        // todo: store letsencrypt files too =>  change it as letsencrypt will be better integrated
        const letsEncrypt = this.configDir + '/letsencrypt';
        if (fs.existsSync(letsEncrypt)) {
            this.copyFolderRecursiveSync(letsEncrypt, tmpDir + '/backup');
        }
        const tar = require('tar');

        const f = fs.createWriteStream(name);
        f.on('finish', () => {
            tools.rmdirRecursiveSync(tmpDir + '/backup');
            if (callback) callback(pathLib.normalize(name));
        });
        f.on('error', err => {
            console.error('host.' + hostname + ' Cannot pack directory ' + tmpDir + '/backup: ' + err);
            this.processExit(EXIT_CODES.CANNOT_GZIP_DIRECTORY);
        });

        try {
            tar.create({gzip: true, cwd: tmpDir + '/'}, ['backup']).pipe(f);
        } catch (err) {
            console.error('host.' + hostname + ' Cannot pack directory ' + tmpDir + '/backup: ' + err);
            this.processExit(EXIT_CODES.CANNOT_GZIP_DIRECTORY);
        }
    }

    createBackup(name, noConfig, callback) {
        if (typeof noConfig === 'function') {
            callback = noConfig;
            noConfig = false;
        }

        const promises = [];

        if (!name) {
            const d = new Date();
            name = d.getFullYear()                   + '_' +
                ('0' + (d.getMonth() + 1)).slice(-2) + '_' +
                ('0' + d.getDate()       ).slice(-2) + '-' +
                ('0' + d.getHours()      ).slice(-2) + '_' +
                ('0' + d.getMinutes()    ).slice(-2) + '_' +
                ('0' + d.getSeconds()    ).slice(-2) + '_backup' + tools.appName;
        }

        name = name.replace(/\\/g, '/');
        if (name.indexOf('/') === -1) {
            const path = this.getBackupDir();

            // create directory if not exists
            if (!fs.existsSync(path)) {
                fs.mkdirSync(path);
            }

            if (name.indexOf('.tar.gz') === -1) {
                name = path + name + '.tar.gz';
            } else {
                name = path + name;
            }
        }

        this.objects.getObjectList({include_docs: true}, (err, res) => {
            const result = {objects: null, states: {}};
            if (!noConfig) {
                result.config = null;
            }
            if (err) {
                console.error('host.' + hostname + ' Cannot get objects: ' + err);
            } else {
                result.objects = res.rows;
            }

            if (!noConfig && fs.existsSync(tools.getConfigFileName())) {
                result.config = JSON.parse(fs.readFileSync(tools.getConfigFileName(), 'utf8'));
            }

            this.states.getKeys('*', (err, keys) => {
                /*for (const i = keys.length - 1; i >= 0; i--) {
                    if (keys[i].match(/^messagebox\./) || keys[i].match(/^log\./)) {
                    keys.splice(i, 1);
                }
                }*/

                this.states.getStates(keys, (err, obj) => {
                    const hostname = tools.getHostName();
                    const r = new RegExp('^system\\.host\\.' + hostname + '\\.(\\w+)$');

                    for (let i = 0; i < keys.length; i++) {
                        if (obj[i].from === 'system.host.' + hostname) {
                            obj[i].from = 'system.host.$$__hostname__$$';
                        }
                        if (r.test(keys[i])) {
                            keys[i] = keys[i].replace(hostname, '$$__hostname__$$');
                        }
                        result.states[keys[i]] = obj[i];
                    }
                    console.log('host.' + hostname + ' ' + keys.length + ' states saved');

                    if (!fs.existsSync(bkpDir)) fs.mkdirSync(bkpDir);
                    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
                    if (!fs.existsSync(tmpDir + '/backup')) fs.mkdirSync(tmpDir + '/backup');
                    if (!fs.existsSync(tmpDir + '/backup/files')) fs.mkdirSync(tmpDir + '/backup/files');

                    // try to find user files
                    for (let j = 0; j < result.objects.length; j++) {
                        if (!result.objects[j].value || !result.objects[j].value._id || !result.objects[j].value.common) continue;
                        //if (result.objects[j].doc) delete result.objects[j].doc;
                        if (result.objects[j].value._id.match(/^system\.adapter\.([\w\d_-]+).(\d+)$/) &&
                            result.objects[j].value.common.host === hostname) {
                            result.objects[j].value.common.host = '$$__hostname__$$';
                            if (result.objects[j].doc) {
                                result.objects[j].doc.common.host = '$$__hostname__$$';
                            }
                        } else if (r.test(result.objects[j].value._id)) {
                            result.objects[j].value._id = result.objects[j].value._id.replace(hostname, '$$__hostname__$$');
                            result.objects[j].id = result.objects[j].value._id;
                            if (result.objects[j].doc) {
                                result.objects[j].doc._id = result.objects[j].value._id;
                            }
                        } else if (result.objects[j].value._id === 'system.host.' + hostname) {
                            result.objects[j].value._id = 'system.host.$$__hostname__$$';
                            result.objects[j].value.common.name = result.objects[j].value._id;
                            result.objects[j].value.common.hostname = '$$__hostname__$$';
                            if (result.objects[j].value.native && result.objects[j].value.native.os) {
                                result.objects[j].value.native.os.hostname = '$$__hostname__$$';
                            }
                            result.objects[j].id = result.objects[j].value._id;
                            if (result.objects[j].doc) {
                                result.objects[j].doc._id = result.objects[j].value._id;
                                result.objects[j].doc.common.name = result.objects[j].value._id;
                                result.objects[j].doc.common.hostname = '$$__hostname__$$';
                                if (result.objects[j].doc.native && result.objects[j].value.native.os) {
                                    result.objects[j].doc.native.os.hostname = '$$__hostname__$$';
                                }
                            }
                        }

                        // Read all files
                        if (result.objects[j].value.type === 'meta' &&
                            result.objects[j].value.common &&
                            result.objects[j].value.common.type === 'meta.user') {
                            promises.push(new Promise(resolve => {
                                this.copyDir(result.objects[j].id, '', tmpDir + '/backup/files/' + result.objects[j].id, resolve);
                            }));
                        } // endIf

                        // Read all files
                        if (result.objects[j].value.type === 'instance' &&
                            result.objects[j].value.common &&
                            result.objects[j].value.common.dataFolder) {
                            let path = result.objects[j].value.common.dataFolder;
                            if (path[0] !== '/' && !path.match(/^\w:/)) {
                                path = pathLib.join(this.configDir, path);
                            }

                            if (fs.existsSync(path)) {
                                this.copyFolderRecursiveSync(path, tmpDir + '/backup');
                            }
                        }
                    }
                    console.log('host.' + hostname + ' ' + result.objects.length + ' objects saved');

                    fs.writeFileSync(tmpDir + '/backup/backup.json', JSON.stringify(result, null, 2));

                    Promise.all(promises).then(() => this.validateBackupAfterCreation(name))
                        .then(() => this.packBackup(name, callback)).catch(e => {
                            console.log(e);
                            this._removeFolderRecursive(tmpDir + /backup/).then(() => this.processExit(26));
                        });
                });
            });

        });
    }

    //--------------------------------------- RESTORE ---------------------------------------------------
    _setStateHelper(_index, statesList, stateObjects, callback) {
        this.states.setRawState(statesList[_index], stateObjects[statesList[_index]], () => {
            if ((_index % 200) === 0) {
                console.log('host.' + hostname + ' Processed ' + _index + '/' + statesList.length + ' states');
            }
            _index++;
            if (_index < statesList.length) {
                setImmediate(this._setStateHelper, _index, statesList, stateObjects, callback);
            } else {
                if (callback) callback();
            }
        });
    }

    _setObjHelper(_index, _objects, callback) {
        // Disable all adapters.
        if (!this.dbMigration
            && _objects[_index].id.match(/^system\.adapter\./)
            && !_objects[_index].id.match(/^system\.adapter\.admin\./)
            && !_objects[_index].id.match(/^system\.adapter\.backitup\./)) {
            if (_objects[_index].doc.common && _objects[_index].doc.common.enabled) {
                _objects[_index].doc.common.enabled = false;
            }
        }
        if (_objects[_index].doc && _objects[_index].doc._rev) delete _objects[_index].doc._rev;

        this.objects.setObject(_objects[_index].id, _objects[_index].doc, (err /* , obj */) => {
            if (err) {
                console.warn('host.' + hostname + ' Cannot restore ' + _objects[_index].id + ': ' + err);
            }

            if ((_index % 200) === 0) console.log('host.' + hostname + ' Processed ' + _index + '/' + _objects.length + ' objects');
            _index++;
            if (_index < _objects.length) {
                setImmediate(this._setObjHelper, _index, _objects, callback);
            } else {
                if (callback) callback();
            }
        });
    }

    reloadAdapterObject(index, objectList, callback) {
        if (objectList && index < objectList.length) {
            this.objects.getObject(objectList[index]._id, (err, obj) => {
                if (err || !obj) {
                    this.objects.setObject(objectList[index]._id, objectList[index], () => {
                        console.log('host.' + hostname + ' object ' + objectList[index]._id + ' created');
                        index++;
                        setImmediate(this.reloadAdapterObject, index, objectList, callback);
                    });
                } else {
                    index++;
                    setImmediate(this.reloadAdapterObject, index, objectList, callback);
                }
            });
        } else {
            if (callback) callback();
        }
    }

    reloadAdaptersObjects(callback, dirs, index) {
        if (!dirs) {
            dirs = [];
            let _modules;
            let p = pathLib.normalize(__dirname + '/../../node_modules');

            if (fs.existsSync(p)) {
                if (p.indexOf('js-controller') === -1) {
                    _modules = fs.readdirSync(p).filter(dir => fs.existsSync(p + '/' + dir + '/io-package.json'));
                    if (_modules) {
                        const regEx = new RegExp('^' + tools.appName + '\\.', 'i');
                        for (let i = 0; i < _modules.length; i++) {
                            if (regEx.test(_modules[i]) &&
                                dirs.indexOf(_modules[i].substring(tools.appName.length + 1)) === -1) {
                                dirs.push(_modules[i]);
                            }
                        }
                    }
                } else {
                    p = pathLib.normalize(__dirname + '/../../../node_modules');
                    if (fs.existsSync(p)) {
                        _modules = fs.readdirSync(p).filter(dir => fs.existsSync(p + '/' + dir + '/io-package.json'));
                        if (_modules) {
                            const regEx = new RegExp('^' + tools.appName + '\\.', 'i');
                            for (let i = 0; i < _modules.length; i++) {
                                if (regEx.test(_modules[i]) &&
                                    dirs.indexOf(_modules[i].substring(tools.appName.length + 1)) === -1) {
                                    dirs.push(_modules[i]);
                                }
                            }
                        }
                    }
                }
            }
            // if installed as npm
            if (fs.existsSync(__dirname + '/../../../../node_modules/' + tools.appName + '.js-controller')) {
                const p = pathLib.normalize(__dirname + '/../../..');
                _modules = fs.readdirSync(p).filter(dir => fs.existsSync(p + '/' + dir + '/io-package.json'));
                const regEx_ = new RegExp('^' + tools.appName + '\\.', 'i');
                for (let j = 0; j < _modules.length; j++) {
                    // if starting from application name + '.'
                    if (regEx_.test(_modules[j]) &&
                        // If not js-controller
                        (_modules[j].substring(tools.appName.length + 1) !== 'js-controller') &&
                        dirs.indexOf(_modules[j].substring(tools.appName.length + 1)) === -1) {
                        dirs.push(_modules[j]);
                    }
                }
            }
            if (dirs.length) {
                this.reloadAdaptersObjects(callback, dirs, 0);
            } else {
                if (callback) callback();
            }
        } else {
            if (index < dirs.length) {
                const adapterName = dirs[index].replace(/^iobroker\./i, '');
                this.upload.uploadAdapter(adapterName, false, true, () => {
                    this.upload.uploadAdapter(adapterName, true, true, () => {
                        let pkg = null;
                        if (!dirs[index]) {
                            console.error('Wrong');
                        }
                        const adapterDir = tools.getAdapterDir(adapterName);
                        if (fs.existsSync(adapterDir + '/io-package.json')) {
                            pkg = JSON.parse(fs.readFileSync(adapterDir + '/io-package.json', 'utf8'));
                        }

                        if (pkg && pkg.objects && pkg.objects.length) {
                            console.log('host.' + hostname + ' Setup "' + dirs[index] + '" adapter');
                            this.reloadAdapterObject(0, pkg.objects, () => {
                                index++;
                                setImmediate(this.reloadAdaptersObjects, callback, dirs, index);
                            });
                        } else {
                            index++;
                            this.reloadAdaptersObjects(callback, dirs, index);
                        }
                    });
                });
            } else {
                if (callback) callback();
            }
        }
    }

    uploadUserFiles(root, path, callback) {
        if (typeof path === 'function') {
            callback = path;
            path = '';
        }

        let called = false;
        if (!fs.existsSync(root)) {
            callback();
            return;
        }
        const files = fs.readdirSync(root + path);
        let count = files.length;
        for (let i = 0; i < files.length; i++) {
            const stat = fs.statSync(root + path + '/' + files[i]);
            if (stat.isDirectory()) {
                called = true;
                this.uploadUserFiles(root, path + '/' + files[i], err => {
                    if (err) console.error('Error: ' + err);
                    if (!--count) setImmediate(callback);
                });
            } else {
                const parts = path.split('/');
                let adapter = parts.splice(0, 2);
                adapter = adapter[1];
                const _path = parts.join('/') + '/' + files[i];
                console.log('host.' + hostname + ' Upload user file "' + adapter + '/' + _path);
                called = true;
                this.objects.writeFile(adapter, _path, fs.readFileSync(root + path + '/' + files[i]), null, err => {
                    if (err) console.error('Error: ' + err);
                    if (!--count) setImmediate(callback);
                });
            }
        }
        if (!called) callback();
    }

    copyBackupedFiles(backupDir, callback) {
        const dirs = fs.readdirSync(backupDir);
        dirs.forEach(dir => {
            if (dir === 'files') return;
            const path = pathLib.join(backupDir, dir);
            const stat = fs.statSync(path);
            if (stat.isDirectory()) {
                this.copyFolderRecursiveSync(path, this.configDir);
            }
        });
        callback && callback();
    }

    restoreAfterStop(restartOnFinish, callback) {
        // Open file
        let data = fs.readFileSync(tmpDir + '/backup/backup.json').toString();
        const hostname = tools.getHostName();
        data = data.replace(/\$\$__hostname__\$\$/g, hostname);
        fs.writeFileSync(tmpDir + '/backup/backup_.json', data);
        let restore;
        try {
            restore = JSON.parse(data);
        } catch (e) {
            console.error('Cannot parse "' + tmpDir + '/backup/backup_.json": ' + e);
            if (callback) callback(31);
        }

        // stop all adapters
        console.log('host.' + hostname + ' Clear all objects and states...');
        this.cleanDatabase(false, () => {
            console.log('host.' + hostname + ' done.');
            // upload all data into DB
            // restore ioBorker.json
            if (restore.config) fs.writeFileSync(tools.getConfigFileName(), JSON.stringify(restore.config, null, 2));

            const sList = Object.keys(restore.states);

            this._setStateHelper(0, sList, restore.states, () => {
                console.log(sList.length + ' states restored.');
                this._setObjHelper(0, restore.objects, () => {
                    console.log(restore.objects.length + ' objects restored.');
                    // Required for upload adapter
                    this.mime = require('mime');
                    // Load user files into DB
                    this.uploadUserFiles(tmpDir + '/backup/files', () => {
                        //  reload objects of adapters
                        this.reloadAdaptersObjects(() => {
                            // Reload host objects
                            const packageIO = JSON.parse(fs.readFileSync(__dirname + '/../../io-package.json', 'utf8'));
                            this.reloadAdapterObject(0, packageIO ? packageIO.objects : null, () => {
                                // copy all files into iob-data
                                this.copyBackupedFiles(pathLib.join(tmpDir, 'backup'), () => {
                                    if (restartOnFinish) {
                                        this.restartController(callback);
                                    } else {
                                        if (callback) callback();
                                    }
                                });
                            });
                        });
                    });
                });
            });
        });
    }

    listBackups() {
        const dir = this.getBackupDir();
        const result = [];
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            for (let i = 0; i < files.length; i++) {
                if (files[i].match(/\.tar\.gz$/i)) {
                    result.push(files[i]);
                }
            }
            return result;
        } else {
            return result;
        }
    }

    validateBackupAfterCreation() {
        return new Promise((resolve, reject) => {
            const backupJSON = require(tmpDir + '/backup/backup.json');
            if (!backupJSON.objects || !backupJSON.objects.length) {
                reject('Backup does not contain valid objects');
            }

            this._checkDirectory(tmpDir + '/backup/files')
                .then(() => {
                    resolve();
                }).catch(e => {
                    reject(e);
                });
        });
    } // endValidateBackupAfterCreation

    validateBackup(name) {
        return new Promise(resolve => {
            let backups;
            if (!name && name !== 0) {
                // List all available backups
                console.log('Please specify one of the backup names:');
                backups = this.listBackups();
                backups.sort((a, b) => b > a);
                if (backups.length) {
                    for (const t in backups) {
                        console.log(backups[t] + ' or ' + backups[t].replace('_backup' + tools.appName + '.tar.gz', '') + ' or ' + t);
                    }
                } else {
                    console.warn('No backups found');
                }
                this.processExit(10);
            }
            // If number
            if (parseInt(name, 10).toString() === name.toString()) {
                backups = this.listBackups();
                backups.sort((a, b) => b > a);
                name = backups[parseInt(name, 10)];
                if (!name) {
                    console.log('No matching backup found');
                    if (backups.length) {
                        console.log('Please specify one of the backup names:');
                        for (const t in backups) {
                            console.log(backups[t] + ' or ' + backups[t].replace('_backup' + tools.appName + '.tar.gz', '') + ' or ' + t);
                        }
                    } // endIf
                } else {
                    console.log('host.' + hostname + ' Using backup file ' + name);
                }
            }

            name = (name || '').toString().replace(/\\/g, '/');
            if (name.indexOf('/') === -1) {
                name = this.getBackupDir() + name;
                const regEx = new RegExp('_backup' + tools.appName, 'i');
                if (!regEx.test(name)) name += '_backup' + tools.appName;
                if (!name.match(/\.tar\.gz$/i)) name += '.tar.gz';
            }
            if (!fs.existsSync(name)) {
                console.error('host.' + hostname + ' Cannot find ' + name);
                this.processExit(11);
            }
            const tar = require('tar');
            if (fs.existsSync(tmpDir + '/backup/backup.json')) {
                fs.unlinkSync(tmpDir + '/backup/backup.json');
            }

            tar.extract({
                file: name,
                cwd: tmpDir
            }, err => {
                if (err) {
                    console.error('host.' + hostname + ' Cannot extract from file "' + name + '"');
                    this.processExit(9);
                }
                if (!fs.existsSync(tmpDir + '/backup/backup.json')) {
                    console.error('host.' + hostname + ' Cannot find extracted file from file "' + tmpDir + '/backup/backup.json"');
                    this.processExit(9);
                }

                console.log('Starting validation ...');
                let backupJSON;
                try {
                    backupJSON = require(tmpDir + '/backup/backup.json');
                } catch (e) {
                    console.error('Backup ' + name + ' does not contain a valid backup.json file: ' + e);
                    this._removeFolderRecursive(tmpDir + '/backup/').then(this.processExit(26));
                }

                if (!backupJSON || !backupJSON.objects || !backupJSON.objects.length) {
                    console.error('Backup does not contain valid objects');
                    this._removeFolderRecursive(tmpDir + '/backup/').then(this.processExit(26));
                } // endIf

                console.log('backup.json OK');

                this._checkDirectory(tmpDir + '/backup/files', true).then(() => this._removeFolderRecursive(tmpDir + '/backup/'))
                    .then(resolve).catch(e => {
                        console.error(e);
                        this.processExit(26);
                    });
            });
        });
    } // endValidateBackup

    _checkDirectory(path, verbose=false) {
        return new Promise((resolve, reject) => {
            const promises = [];
            if (fs.existsSync(path)) {
                const files = fs.readdirSync(path);
                if (!files.length) resolve();
                for (const file of files) {
                    const filePath = path + '/' + file;
                    if(fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
                    // if directory then check it
                        promises.push(this._checkDirectory(filePath, verbose));
                    } else if (file.endsWith('.json')) {
                        try {
                            require(filePath);
                            if (verbose) console.log(file + ' OK');
                            resolve();
                        } catch (e) {
                            reject(filePath + ' is not a valid json file');
                        }
                    }
                }
            } // endIf

            Promise.all(promises).then(resolve).catch(e => reject(e));
        });
    } // endCheckDirectory

    restoreBackup(name, callback) {
        let backups;
        if (!name && name !== 0) {
            // List all available backups
            console.log('Please specify one of the backup names:');
            backups = this.listBackups();
            backups.sort((a, b) => b > a);
            if (backups.length) {
                for (let t = 0; t < backups.length; t++) {
                    console.log(backups[t] + ' or ' + backups[t].replace('_backup' + tools.appName + '.tar.gz', '') + ' or ' + t);
                }
            } else {
                console.warn('No backups found');
            }
            this.processExit(10);
        }

        if (!this.cleanDatabase) throw 'Invalid arguments: cleanDatabase is missing';
        if (!this.restartController) throw 'Invalid arguments: restartController is missing';

        // If number
        if (parseInt(name, 10).toString() === name.toString()) {
            backups = this.listBackups();
            backups.sort((a, b) => b > a);
            name = backups[parseInt(name, 10)];
            if (!name) {
                console.log('No matching backup found');
                if (backups.length) {
                    console.log('Please specify one of the backup names:');
                    for (let t = 0; t < backups.length; t++) {
                        console.log(backups[t] + ' or ' + backups[t].replace('_backup' + tools.appName + '.tar.gz', '') + ' or ' + t);
                    }
                } // endIf
            } else {
                console.log('host.' + hostname + ' Using backup file ' + name);
            }
        }

        name = (name || '').toString().replace(/\\/g, '/');
        if (name.indexOf('/') === -1) {
            name = this.getBackupDir() + name;
            const regEx = new RegExp('_backup' + tools.appName, 'i');
            if (!regEx.test(name)) name += '_backup' + tools.appName;
            if (!name.match(/\.tar\.gz$/i)) name += '.tar.gz';
        }
        if (!fs.existsSync(name)) {
            console.error('host.' + hostname + ' Cannot find ' + name);
            this.processExit(11);
        }
        const tar = require('tar');
        if (fs.existsSync(tmpDir + '/backup/backup.json')) {
            fs.unlinkSync(tmpDir + '/backup/backup.json');
        }

        tar.extract({
            file: name,
            cwd: tmpDir
        }, err => {
            if (err) {
                console.error('host.' + hostname + ' Cannot extract from file "' + name + '"');
                this.processExit(9);
            }
            if (!fs.existsSync(tmpDir + '/backup/backup.json')) {
                console.error('host.' + hostname + ' Cannot find extracted file from file "' + tmpDir + '/backup/backup.json"');
                this.processExit(9);
            }
            // Stop controller
            const daemon = require('daemonize2').setup({
                main: '../../controller.js',
                name: tools.appName + ' controller',
                pidfile: __dirname + '/../' + tools.appName + '.pid',
                cwd: '../../',
                stopTimeout: 1000
            });
            daemon.on('error', (/* error */) => this.restoreAfterStop(false, callback));
            daemon.on('stopped', () => this.restoreAfterStop(true, callback));
            daemon.on('notrunning', () => {
                console.log('host.' + hostname + ' OK.');
                this.restoreAfterStop(false, callback);
            });
            daemon.stop();
        });
    }
}

module.exports = BackupRestore;
