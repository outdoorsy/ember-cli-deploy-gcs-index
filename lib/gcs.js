/* eslint-env node */
'use strict';

var gcloud          = require('google-cloud');
var CoreObject      = require('core-object');
var RSVP            = require('rsvp');
var fs              = require('fs');
var readFile        = RSVP.denodeify(fs.readFile);
var mime            = require('mime-types');
var joinUriSegments = require('./util/join-uri-segments');

module.exports = CoreObject.extend({
  init: function(options) {
    var plugin = options.plugin;
    var config = plugin.pluginConfig;

    this._plugin = plugin;
    this._client = gcloud.storage({
      projectId: options.projectId,
      keyFilename: options.keyFilename
    });

    this._super.init && this._super.init.apply(this, arguments);
  },

  upload: function(options) {
    var client           = this._client;
    var plugin           = this._plugin;
    var bucket           = this._client.bucket(options.bucket);
    var acl              = options.acl;
    var allowOverwrite   = options.allowOverwrite;
    var key              = options.filePattern + ":" + options.revisionKey;
    var revisionKey      = joinUriSegments(options.prefix, key);
    var gzippedFilePaths = options.gzippedFilePaths || [];
    var isGzipped        = gzippedFilePaths.indexOf(options.filePattern) !== -1;

    var params = {
      metadata: {
        contentType: mime.lookup(options.filePath) || 'text/html',
        cacheControl: 'max-age=0, no-cache',
        acl: acl
      }
    };

    if (isGzipped) {
      params.gzip = true;
    }

    return this.fetchRevisions(options)
      .then(function(revisions) {
        var found = revisions.map(function(element) { return element.revision; }).indexOf(options.revisionKey);
        if (found >= 0 && !allowOverwrite) {
          return RSVP.reject("REVISION ALREADY UPLOADED! (set `allowOverwrite: true` if you want to support overwriting revisions)");
        }
        return RSVP.resolve();
      })
      .then(function() {
        var file = bucket.file(revisionKey);

        return new RSVP.Promise(function(resolve, reject) {
          fs.createReadStream(options.filePath)
            .pipe(file.createWriteStream(params))
            .on('error', function(error) {
              reject(error);
            })
            .on('finish', function() {
              plugin.log('✔  ' + revisionKey, { verbose: true });
              resolve();
            });
        });
      });
  },

  activate: function(options) {
    var plugin      = this._plugin;
    var client      = this._client;
    var bucket      = this._client.bucket(options.bucket);
    var acl         = options.acl || [];
    var prefix      = options.prefix;
    var filePattern = options.filePattern;
    var key         = filePattern + ":" + options.revisionKey;
    var meta        = options.meta || {};

    if (!meta.cacheControl) {
      meta.cacheControl =  'max-age=0, no-cache';
    }

    if (!meta.metadata) {
      meta.metadata = {};
    }

    meta.metadata.revision =  options.revisionKey;

    var revisionKey = joinUriSegments(prefix, key);
    var indexKey    = joinUriSegments(prefix, filePattern);
    let file = bucket.file(revisionKey);
    var copyObject  = RSVP.denodeify(file.copy.bind(file));

    return this.fetchRevisions(options).then(function(revisions) {
      var found = revisions.map(function(element) { return element.revision; }).indexOf(options.revisionKey);
      if (found >= 0) {
        return copyObject(indexKey).then(function(file) {
          var makePublic  = RSVP.denodeify(file.makePublic.bind(file));
          var setMetadata = RSVP.denodeify(file.setMetadata.bind(file));
          return makePublic().then(function() {
            return setMetadata(meta).then(function(){
              plugin.log('✔  ' + revisionKey + " => " + indexKey);
            });
          }, function(err) {
            plugin.log(err,err);
          });
        });
      } else {
        return RSVP.reject("REVISION NOT FOUND!"); // see how we should handle a pipeline failure
      }
    });
  },

  fetchRevisions: function(options) {
    var client         = this._client;
    var bucket         = this._client.bucket(options.bucket);
    var prefix         = options.prefix;
    var revisionPrefix = joinUriSegments(prefix, options.filePattern + ":");
    var indexKey       = joinUriSegments(prefix, options.filePattern);

    return RSVP.hash({
      revisions: new RSVP.Promise(function(resolve, reject) {
        bucket.getFiles({
          prefix: revisionPrefix
        }, function(error, files) {
          if (!error) {
            resolve(files);
          } else {
            reject(error);
          }
        });
      }),
      current: new RSVP.Promise(function(resolve, reject) {
        bucket.file(indexKey).getMetadata(
          function(error, metadata, response) {
            if (error) {
              if (response && response.error && response.error.code === 404) {
                resolve();
              } else {
                reject(error);
              }
            } else {
              resolve(metadata);
            }
          }
        );
      })
    })
      .then(function(data) {
        return data.revisions.sort(function(a, b) {
          return new Date(b.metadata.updated) - new Date(a.metadata.updated);
        }).map(function(d) {
          var revision = d.name.substr(revisionPrefix.length);
          var active = data.current && d.name.indexOf(data.current.metadata.revision) >= 0;
          return { revision: revision, timestamp: d.metadata.updated, active: active };
        });
      });
  }
});
