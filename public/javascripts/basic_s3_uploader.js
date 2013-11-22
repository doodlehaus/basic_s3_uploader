// Simple constructor. Accepts a file object and some settings.
var BasicS3Uploader = function(file, settings) {
  var uploader = this; 
  uploader.file = file;
  uploader._XHRs = [];
  uploader._configureUploader(settings);
  uploader._notifyUploaderReady();
  uploader._setReady();
}

// Configure the uploader using the provided settings or sensible defaults.
BasicS3Uploader.prototype._configureUploader = function(settings) {
  var uploader = this;

  uploader.settings = {};

  uploader.settings.contentType      = settings.contentType || uploader.file.type;
  uploader.settings.chunkSize        = settings.chunkSize || 1024 * 1024 * 10; // 10MB
  uploader.settings.encrypted        = settings.encrypted || false;
  uploader.settings.maxRetries       = settings.maxRetries || 5;
  uploader.settings.maxRetries       = settings.maxFileSize || 1024 * 1024 * 1024 * 5; // 5GB
  uploader.settings.acl              = settings.acl || "public-read";
  uploader.settings.signatureBackend = settings.signatureBackend || "";
  uploader.settings.bucket           = settings.bucket || "your-bucket-name";
  uploader.settings.host             = settings.host || "http://" + uploader.settings.bucket + "." + "s3.amazonaws.com";
  uploader.settings.awsAccessKey     = settings.awsAccessKey || "YOUR_AWS_ACCESS_KEY_ID";
  uploader.settings.log              = settings.log || false;

  // Generates a default key to use for the upload if none was provided.
  var defaultKey = "/" + uploader.settings.bucket + "/" + new Date().getTime() + "_" + uploader.file.name;
  uploader.settings.key = settings.key || defaultKey;

  // Events
  uploader.settings.onReady    = settings.onReady || function() {};
  uploader.settings.onStart    = settings.onStart || function() {};
  uploader.settings.onProgress = settings.onProgress || function(loaded, total) {};
  uploader.settings.onComplete = settings.onComplete || function(location) {};
  uploader.settings.onError    = settings.onError || function(message) {};
  uploader.settings.onRetry    = settings.onRetry || function(attempts) {};
  uploader.settings.onCancel   = settings.onCancel || function() {};

}

// Start the upload, but only if the file is deemed "readable". 
BasicS3Uploader.prototype.startUpload = function() {
  var uploader = this; 

  if (uploader._isUploading()) {
    return;
  }

  if (uploader.file.size > uploader.settings.maxFileSize) {
    uploader._notifyUploadError("The file could not be uploaded because it exceeds the maximum file size allowed.");
    uploader._setFailed();
    return;
  }

  uploader._validateFileIsReadable(function(valid) {
    if (valid) {
      uploader._createChunks();
      uploader._notifyUploadStarted();
      uploader._setUploading();
      uploader._getInitSignature();
    } else {
      uploader._notifyUploadError("The file could not be uploaded because it cannot be read");
      uploader._setFailed();
    }
  });

}

// Cancels all XHR requests.
BasicS3Uploader.prototype.cancelUpload = function() {
  var uploader = this;
  var xhr;

  if (!uploader._isUploading()) {
    return;
  }

  for (index in uploader._XHRs) {
    uploader._XHRs[index].abort();
  }

  uploader._XHRs = [];
  uploader._notifyUploadCancelled();
  uploader._setCancelled();
}

// Slices up the file into chunks, storing the startRange and endRange of each chunk on the uploader
// so the blobs can be created when needed.
BasicS3Uploader.prototype._createChunks = function() {
  var uploader = this;
  var chunks = {}

  var chunkSize = Math.min(uploader.settings.chunkSize, uploader.file.size);
  var totalChunks = Math.ceil(uploader.file.size / chunkSize);

  var remainingSize, startRange, endRange, sizeOfChunk;

  for(var partNumber = 1; partNumber < totalChunks + 1; partNumber++) {
    remainingSize = remainingSize || uploader.file.size;
    startRange = startRange || 0;
    sizeOfChunk = sizeOfChunk || chunkSize * partNumber;

    endRange = (startRange + sizeOfChunk) - 1;

    chunks[partNumber] = {startRange: startRange, endRange: endRange};

    startRange = (chunkSize * partNumber);
    remainingSize = remainingSize - sizeOfChunk;

    if (remainingSize < sizeOfChunk) {
      sizeOfChunk = remainingSize;
    }
  }
  uploader._chunks = chunks;
}

// Call to the provided signature backend to get the init signature.
// The response should look something like:
//    { signature: "some-signature", date: "the date for this request" }
BasicS3Uploader.prototype._getInitSignature = function(retries) {
  var uploader = this;
  var attempts = retries || 0;

  uploader._ajax({
    url: uploader.settings.signatureBackend + '/get_init_signature',
    method: "GET",
    params: {
      key: uploader.settings.key,
      filename: uploader.file.name,
      filesize: uploader.file.size,
      mime_type: uploader.settings.contentType,
      bucket: uploader.settings.bucket,
      acl: uploader.settings.acl,
      encrypted: uploader.settings.encrypted
    },
    success: function(response) {
      var xhr = this;
      if (xhr.status == 200) {
        var json = JSON.parse(response.target.responseText);
        uploader._initSignature = json['signature'];
        uploader._date = json['date'];
        uploader._initiateUpload();
      } else {
        xhr._data.error();
      }
    },
    error: function(response) {
      if (uploader._retryAvailable(attempts)) {
        attempts += 1;
        setTimeout(function() {
          uploader._notifyUploadRetry(attempts);
          uploader._getInitSignature(attempts);
        }, 2000 * attempts)
      } else {
        uploader._notifyUploadError("Max number of retries have been met. Unable to get init signature!");
        uploader._setFailed();
      }
    }
  });
}

// Initiate a new upload to S3 using the init signature. This will return an UploadId
// when successful.
BasicS3Uploader.prototype._initiateUpload = function(retries) {
  var uploader = this;
  var attempts = retries || 0;
  var authorization = "AWS " + uploader.settings.awsAccessKey + ":" + uploader._initSignature;

  var headers = {
    "x-amz-date": uploader._date,
    "x-amz-acl": uploader.settings.acl,
    "Authorization": authorization,
    "Content-Disposition": "attachment; filename=" + uploader.file.name
  };

  if (uploader.settings.encrypted) {
    headers["x-amz-server-side-encryption"] = "AES256";
  }

  uploader._ajax({
    url: uploader.settings.host + "/" + uploader.settings.key + "?uploads",
    method: "POST",
    headers: headers,
    success: function(response) {
      var xhr = this;
      if (xhr.status == 200) {
        var xml = response.target.responseXML;
        uploader._uploadId = xml.getElementsByTagName('UploadId')[0].textContent;
        uploader._getRemainingSignatures();
      } else {
        xhr._data.error();
      }
    },
    error: function(response) {
      if (uploader._retryAvailable(attempts)) {
        attempts += 1;
        setTimeout(function() {
          uploader._notifyUploadRetry(attempts);
          uploader._initiateUpload(attempts);
        }, 2000 * attempts)
      } else {
        uploader._notifyUploadError("Max number of retries have been met. Unable to initiate an upload request!");
        uploader._setFailed();
      }
    }
  });
}

// Using the UploadId, retrieve the remaining signatures required for uploads
// from the signature backend. The response should include all chunk signatures,
// a "list parts" signature, and a "complete" signature. A sample response might
// look something like this:
//
// {
//   chunk_signatures: {
//     1: { signature: "signature", date: "date" },
//     2: { signature: "signature", date: "date" },
//     3: { signature: "signature", date: "date" },
//   },
//   complete_signature: { signature: "signature", date: "date" },
//   list_signature: { signature: "signature", date: "date" }
// }
//
// Note that for the chunk_signatures section, the key corresponds to the 
// part number (or chunk number).
BasicS3Uploader.prototype._getRemainingSignatures = function(retries) {
  var uploader = this;
  var attempts = retries || 0;

  uploader._ajax({
    url: uploader.settings.signatureBackend + "/get_all_signatures",
    params: {
      upload_id: uploader._uploadId,
      total_chunks: Object.keys(uploader._chunks).length,
      mime_type: uploader.settings.contentType,
      bucket: uploader.settings.bucket,
      key: uploader.settings.key
    },
    success: function(response) {
      var xhr = this;
      if (xhr.status == 200) {
        var json = JSON.parse(response.target.responseText);

        uploader._chunkSignatures = json['chunk_signatures'];
        uploader._completeSignature = json['complete_signature'];
        uploader._listSignature = json['list_signature'];

        uploader._uploadChunks();
      } else { 
        xhr._data.error();
      }
    },
    error: function(response) {
      if (uploader._retryAvailable(attempts)) {
        attempts += 1;
        setTimeout(function() {
          uploader._notifyUploadRetry(attempts);
          uploader._getRemainingSignatures(attempts);
        }, 2000 * attempts)
      } else {
        uploader._notifyUploadError("Max number of retries have been met. Unable to retrieve remaining signatures!");
        uploader._setFailed();
      }
    }
  });
}

// Iterate over all chunks and start all uploads simultaneously
BasicS3Uploader.prototype._uploadChunks = function() {
  var uploader = this;
  uploader._eTags = {}
  uploader._chunkProgress = {};

  var totalChunks = Object.keys(uploader._chunks).length;

  for(var chunkNumber = 1; chunkNumber < totalChunks + 1; chunkNumber++) {
    var chunk = uploader._chunks[chunkNumber];
    uploader._uploadChunk(chunkNumber);
  }
}

// Uploads a single chunk to S3. Because multiple chunks can be uploading at
// the same time, the "success" callback for this request checks to see if all
// chunks have been uploaded. If they have, the uploader will try to complete
// the upload.
BasicS3Uploader.prototype._uploadChunk = function(number, retries) {
  var uploader = this;
  var attempts = retries || 0;

  var chunk = uploader._chunks[number];
  var signature = uploader._chunkSignatures[number].signature;
  var date = uploader._chunkSignatures[number].date;
  var authorization = "AWS " + uploader.settings.awsAccessKey + ":" + signature;

  uploader._ajax({
    url: uploader.settings.host + "/" + uploader.settings.key,
    method: "PUT",
    body: uploader.file.slice(chunk.startRange, chunk.endRange),
    params: {
      uploadId: uploader._uploadId,
      partNumber: number,
    },
    headers: {
      "x-amz-date": date,
      "Authorization": authorization,
      "Content-Disposition": "attachment; filename=" + uploader.file.name,
      "Content-Type": uploader.settings.contentType,
    },
    progress: function(response) {
      uploader._chunkProgress[number] = response.loaded;
      uploader._notifyUploadProgress();
    },
    success: function(response) {
      var xhr = this;
      if (xhr.status == 200) {
        var eTag = xhr.getResponseHeader("ETag");
        if (eTag && eTag.length > 0) {
          eTag = uploader._getETag(eTag);
          uploader._eTags[number] = eTag;
        }

        if (uploader._allETagsAvailable()) {
          uploader._verifyAllChunksUploaded();
        }
      } else {
        xhr._data.error();
      }
    },
    error: function(response) {
      if (uploader._retryAvailable(attempts)) {
        attempts += 1;
        setTimeout(function() {
          uploader._notifyUploadRetry(attempts);
          uploader._uploadChunk(number, attempts);
        }, 2000 * attempts)
      } else {
        uploader._notifyUploadError("Max number of retries have been met. Upload of chunk #" + number + " failed!");
        uploader._setFailed();
      }
    }
  });
}

// Calls the S3 "List chunks" API and compares the result to the chunks the uploader
// sent. If any chunk is invalid (missing eTag, invalid size, different number of chunks)
// then the uploader attempts to re-upload that chunk.
BasicS3Uploader.prototype._verifyAllChunksUploaded = function(retries) {
  var uploader = this;
  var attempts = retries || 0;
  var signature = uploader._listSignature.signature;
  var date = uploader._listSignature.date;
  var authorization = "AWS " + uploader.settings.awsAccessKey + ":" + signature;

  uploader._ajax({
    url: uploader.settings.host + "/" + uploader.settings.key,
    method: "GET",
    params: {
      uploadId: uploader._uploadId,
    },
    headers: {
      "x-amz-date": date,
      "Authorization": authorization
    },
    success: function(response) {
      var xhr = this;

      if (xhr.status == 200) {

        var xml = response.target.responseXML;
        var invalidParts = [];
        var parts = xml.getElementsByTagName("Part");
        var totalParts = Object.keys(uploader._chunks).length;

        for (var i = 0; i < parts.length; i++) {
          var part = parts[i];

          var number = parseInt(part.getElementsByTagName("PartNumber")[0].textContent, 10);
          var eTag = uploader._getETag(part.getElementsByTagName("ETag")[0].textContent);
          var size = parseInt(part.getElementsByTagName("Size")[0].textContent, 10);

          var uploadedChunk = uploader._chunks[number];
          var expectedSize = uploadedChunk.endRange - uploadedChunk.startRange;

          if (!uploadedChunk || eTag != uploader._eTags[number] || size != expectedSize) {
            invalidParts.push(number);
          }
        }

        if (totalParts != parts.length) {
          uploader._handleMissingChunks(parts);
        } else if (invalidParts.length > 0) {
          uploader._handleInvalidChunks(invalidParts);
        } else {
          uploader._completeUpload();
        }

      } else {
        xhr._data.error();
      }

    },
    error: function(response) {
      if (uploader._retryAvailable(attempts)) {
        attempts += 1;
        setTimeout(function() {
          uploader._notifyUploadRetry(attempts);
          uploader._verifyAllChunksUploaded(attempts);
        }, 2000 * attempts)
      } else {
        uploader._notifyUploadError("Max number of retries have been met. Unable to verify all chunks have uploaded!");
        uploader._setFailed();
      }
    }
  });
}

// Iterates over the list of invalid chunks and calls _retryChunk.
BasicS3Uploader.prototype._handleInvalidChunks = function(invalidParts) {
  var uploader = this;
  for (var i = 0; i < invalidParts.length; i++) {
    var chunkNumber = invalidParts[i];
    uploader._retryChunk(chunkNumber);
  }
}

// Determines if S3 is missing any chunks that were sent, then retries uploading
// the missing chunks via _retryChunk.
BasicS3Uploader.prototype._handleMissingChunks = function(chunksFromS3) {
  var uploader = this;
  var chunkNumbersFromS3 = [];

  // The part numbers that S3 reported
  for (var i = 0; i < chunksFromS3.length; i++) {
    var chunk = chunksFromS3[i];
    chunkNumbersFromS3.push(chunk.getElementsByTagName("PartNumber")[0].textContent);
  }

  // Send the missing parts
  for (var chunkNumber in uploader._chunks) {
    if (chunkNumbersFromS3.indexOf(chunkNumber) == -1) {
      uploader._retryChunk(chunkNumber);
    }
  }
}

// Attempts to retry a chunk upload, if a retry is available.
BasicS3Uploader.prototype._retryChunk = function(chunkNumber) {
  var uploader = this;
  var chunkAttempts = uploader._chunks[chunkNumber].attempts || 0;

  if (uploader._retryAvailable(chunkAttempts)) {
    chunkAttempts += 1;
    uploader._chunks[chunkNumber].attempts = chunkAttempts;
    uploader._uploadChunk(chunkNumber, chunkAttempts);
  } else {
    uploader._notifyUploadError("Max number of retries has been met. Cannot retry uploading chunk!");
    uploader._setFailed();
  }
}

// Completes the multipart upload, effectively assembling all chunks together
// into one file.
BasicS3Uploader.prototype._completeUpload = function(retries) {
  var uploader = this;
  var attempts = retries || 0;
  var signature = uploader._completeSignature.signature;
  var sortedETags = [];

  for (var chunkNumber = 1; chunkNumber < Object.keys(uploader._eTags).length + 1; chunkNumber++) {
    sortedETags.push(uploader._eTags[chunkNumber]);
  }

  var authorization = "AWS " + uploader.settings.awsAccessKey + ":" + signature;

  var body = "<CompleteMultipartUpload>";

  for (chunkNumber in uploader._eTags) {
    body += "<Part>";
    body += "<PartNumber>" + chunkNumber + "</PartNumber>";
    body += "<ETag>" + uploader._eTags[chunkNumber] + "</ETag>";
    body += "</Part>";
  }

  body += "</CompleteMultipartUpload>";

  uploader._ajax({
    url: uploader.settings.host + "/" + uploader.settings.key,
    method: "POST",
    body: body,
    params: {
      uploadId: uploader._uploadId
    },
    headers: {
      "x-amz-date": uploader._completeSignature.date,
      "Authorization": authorization,
      "Content-Type": uploader.settings.contentType,
      "Content-Disposition": "attachment; filename=" + uploader.file.name
    },
    success: function(response) {
      var xhr = this;
      if (xhr.status == 200) {
        var xml = response.target.responseXML;
        var location = xml.getElementsByTagName('Location')[0].textContent;
        if (location) {
          uploader._notifyUploadComplete(location);
          uploader._setComplete();
        }
      } else {
        xhr._data.error();
      }
    },
    error: function(response) {
      if (uploader._retryAvailable(attempts)) {
        attempts += 1;
        setTimeout(function() {
          uploader._notifyUploadRetry(attempts);
          uploader._completeUpload(attempts);
        }, 2000 * attempts)
      } else {
        uploader._notifyUploadError("Max number of retries have been met. Unable to complete multipart upload!");
        uploader._setFailed();
      }
    }
  });
  
}

// Returns true if attemts is less than maxRetries. Note that the first attempt
// (a non-retry attempt) is not counted.
BasicS3Uploader.prototype._retryAvailable = function(attempts) {
  var uploader = this;
  if (uploader._isCancelled() || uploader._isFailed()) {
    return false;
  }
  return (attempts + 1) < uploader.settings.maxRetries + 1;
}

// Returns true if we have an eTag for every chunk
BasicS3Uploader.prototype._allETagsAvailable = function() {
  var uploader = this;
  return Object.keys(uploader._eTags).length == Object.keys(uploader._chunks).length;
}

// State-related methods
BasicS3Uploader.prototype._setReady = function() {
  var uploader = this;
  uploader._status = "ready";
}

BasicS3Uploader.prototype._isReady = function() {
  var uploader = this;
  return uploader._status == "ready";
}

BasicS3Uploader.prototype._setUploading = function() {
  var uploader = this;
  uploader._status = "uploading";
}

BasicS3Uploader.prototype._isUploading = function() {
  var uploader = this;
  return uploader._status == "uploading";
}

BasicS3Uploader.prototype._setComplete = function() {
  var uploader = this;
  uploader._status = "complete";
}

BasicS3Uploader.prototype._isComplete = function() {
  var uploader = this;
  return uploader._status == "complete";
}

BasicS3Uploader.prototype._setCancelled = function() {
  var uploader = this;
  uploader._status = "cancelled";
}

BasicS3Uploader.prototype._isCancelled = function() {
  var uploader = this;
  return uploader._status == "cancelled";
}

BasicS3Uploader.prototype._setFailed = function() {
  var uploader = this;
  uploader._status = "failed";
}

BasicS3Uploader.prototype._isFailed = function() {
  var uploader = this;
  return uploader._status == "failed";
}

// Notification that the uploader is initialized. Calls the user-defined "onReady" 
// method.
BasicS3Uploader.prototype._notifyUploaderReady = function() {
  var uploader = this;
  uploader.settings.onReady.call(uploader);
}

// Notification that the uploader has started uploading chunks. Calls the user-defined
// onStart method.
BasicS3Uploader.prototype._notifyUploadStarted = function() {
  var uploader = this;
  uploader.settings.onStart.call(uploader);
}

// Notification for upload progress. Iterates over the chunkProgresses and tallies
// up the bytes loaded. Calls the user-defined onProgress method, sending in the
// total loaded and the total file size remaining. From this data, overall upload
// progress can be determined.
BasicS3Uploader.prototype._notifyUploadProgress = function() {
  var uploader = this;
  var loaded = 0;

  for (chunkNumber in uploader._chunkProgress) {
    loaded += uploader._chunkProgress[chunkNumber];
  }

  var total = uploader.file.size;

  uploader.settings.onProgress.call(uploader, loaded, total);
}

// Notifies when the upload has finished and the parts have been assembled. Calls
// the user-defined onComplete method.
BasicS3Uploader.prototype._notifyUploadComplete = function(location) {
  var uploader = this;
  uploader.settings.onComplete.call(uploader, location);
}

// Notifies that an error has occurred with the uploader. Calls the user-defined
// onError method, sending in any error message that may exist.
BasicS3Uploader.prototype._notifyUploadError = function(message) {
  var uploader = this;
  uploader.settings.onError.call(uploader, message);
}

// Notifies that a retry is being attempted. Calls the user-defined onRetry
// method, sending the attempt number.
BasicS3Uploader.prototype._notifyUploadRetry = function(attempt) {
  var uploader = this;
  uploader.settings.onRetry.call(uploader, attempt);
}

// Notifies that the upload has been cancelled. Calls the user-defined onCancel
// method.
BasicS3Uploader.prototype._notifyUploadCancelled = function() {
  var uploader = this;
  uploader.settings.onCancel.call(uploader);
}

BasicS3Uploader.prototype._log = function(msg, object) {
  if (this.settings.log) {
    if (object) {
      console.log(msg, object);
    } else {
      console.log(msg);
    }
  }
}

BasicS3Uploader.prototype._getETag = function(eTag) {
  var uploader = this;
  return eTag.match(/^"([a-zA-Z0-9]+)"$/)[1];
}

// A convenient and uniform way for creating and sending XHR requests.
BasicS3Uploader.prototype._ajax = function(data) {
  var uploader = this;
  var url = data.url;
  var method = data.method || "GET";
  var body = data.body;
  var params = data.params;
  var headers = data.headers || {};

  var success = data.success || function(response) {};
  var error = data.error || function(response) {};
  var stateChange = data.stateChange || function(response) {};
  var progress = data.progress || function(response) {};

  var xhr = new XMLHttpRequest();
  xhr._data = data;

  xhr.addEventListener("error", error, true);
  xhr.addEventListener("timeout", error, true);
  xhr.addEventListener("load", success, true);
  xhr.addEventListener("readystatechange", stateChange);
  xhr.upload.addEventListener("progress", progress);

  if (params) {
    for (name in params) {
      if (url.indexOf('?') !== -1) {
        url += "&";
      } else {
        url += "?";
      }

      url += encodeURIComponent(name) + "=";
      url += encodeURIComponent(params[name]);
    }
  }

  xhr.open(method, url);

  for (var header in headers) {
    xhr.setRequestHeader(header, headers[header]);
  }

  if (body) {
    xhr.send(body);
  } else {
    xhr.send();
  }
  uploader._XHRs.push(xhr);
  return xhr;
}

// Using the FileReader API, this method attempts to open the file and read the
// first few bytes. This method accepts a callback and then calls it with the result
// of the check.
BasicS3Uploader.prototype._validateFileIsReadable = function(callback) {
  var uploader = this;
  var file = uploader.file;
  var blob = file.slice(0, 1024);
  var fr = new FileReader()

  fr.onloadend = function() {
    if (fr.error) {
      callback(false);
    } else {
      callback(true);
    }
  }

  fr.readAsBinaryString(blob);
}
