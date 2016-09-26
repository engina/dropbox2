[![Build status](https://img.shields.io/travis/engina/dropbox2.svg?style=flat-square)](https://travis-ci.org/engina/dropbox2)
[![Coverage](https://img.shields.io/codecov/c/github/engina/dropbox2.svg?style=flat-square)](https://codecov.io/github/engina/dropbox2)

<a name="Dropbox"></a>

## Dropbox
This is the unofficial Dropbox API client implementation.

It provides following missing features of the official client library:

1. Downloads and uploads file in a streaming fashion to consume minimal memory. Official library
buffers downloads.
2. Central throttling of all API request so that we won't get the 429 HTTP Error.
3. Automatic retries on temporary errors (such as 500 and 429).

This implementation offers a promise based interface. All success and errors are reported
by resolving or rejecting returned promises.

However, some diagnostic messages are communicated via events.

These events will be fired from [events](#Dropbox.events) object which is an EventEmitter2 instance.

However, you can provide your own emit function with the prototype *emit(eventType: string, ...) to
emit events from your own instances or just log the diagnostic messages.

This client also offers a Dropbox.stats object for futher statistical information. If no custom stats
object is provided static [stats](#Dropbox.stats) object will be updated. This can be used to keep track of
stats per user account etc.

**Kind**: global class  
**Emits**: <code>event:log</code>, <code>event:retry</code>  
## install
----------
```
npm install dropbox2
```
## examples
````js
const Dropbox = require('dropbox2');

// First parameter is the access token of the target user
// Second parameter is the HTTP end point as documented in https://dropbox.github.io/dropbox-api-v2-explorer/
// Third parameter is the parameters of the above end point as documented above.
Dropbox.rpcRequest(ACCESS_TOKEN, 'files/list_folder', {path: ''})
.then(result => {
  console.log(result.entries);
});
```


* [Dropbox](#Dropbox)
    * [.RequestError](#Dropbox.RequestError)
    * [.THROTTLER](#Dropbox.THROTTLER)
    * [.AGENT](#Dropbox.AGENT)
    * [.MAX_RETRY](#Dropbox.MAX_RETRY)
    * [.events](#Dropbox.events)
    * [.DefaultEmitter](#Dropbox.DefaultEmitter)
    * [.stats](#Dropbox.stats)
        * [.flight](#Dropbox.stats.flight)
        * [.pending](#Dropbox.stats.pending)
        * [.completed](#Dropbox.stats.completed)
        * [.errors](#Dropbox.stats.errors)
        * [.retries](#Dropbox.stats.retries)
    * [.rawRequest(options, emit, stats)](#Dropbox.rawRequest) ⇒ <code>Promise.&lt;Object&gt;</code>
    * [.rpcRequest(accessToken, endpoint, parameters, [emit])](#Dropbox.rpcRequest) ⇒ <code>Promise</code>
    * [.download(accessToken, src, dst, options)](#Dropbox.download) ⇒ <code>Promise</code>
    * [.upload(accessToken, src, dstPath, parameters)](#Dropbox.upload) ⇒ <code>Promise</code>

<a name="Dropbox.RequestError"></a>

### Dropbox.RequestError
Encapsulates an error message regarding a request.

Error message is in `message` property as per usual.

Request options that caused the error is in the `options` property.

Original error (if there is any) will be in `error` property.

**Kind**: static class of <code>[Dropbox](#Dropbox)</code>  
<a name="Dropbox.THROTTLER"></a>

### Dropbox.THROTTLER
Throttles HTTP API requests per account id.

NOTE: npm package limiter is buggy https://github.com/jhurliman/node-rate-limiter/issues/25
Yet, the default value is a sweet spot for Dropbox API, so it should be fine, for now.

**Kind**: static property of <code>[Dropbox](#Dropbox)</code>  
**Default**: <code>is 600 requests per minute. With 600 request burst capacity.</code>  
<a name="Dropbox.AGENT"></a>

### Dropbox.AGENT
HTTPS agent to be used for the communication.

**Kind**: static property of <code>[Dropbox](#Dropbox)</code>  
<a name="Dropbox.MAX_RETRY"></a>

### Dropbox.MAX_RETRY
If a request is failed with HTTP 500, it is considered a temporary problem and the request
is resend. This is the maximum resend attempt.

**Kind**: static property of <code>[Dropbox](#Dropbox)</code>  
<a name="Dropbox.events"></a>

### Dropbox.events
If you haven't provided a custom emit function, this object will be used to
emit diagnostic messages.

**Kind**: static property of <code>[Dropbox](#Dropbox)</code>  
<a name="Dropbox.DefaultEmitter"></a>

### Dropbox.DefaultEmitter
Default emitter

**Kind**: static property of <code>[Dropbox](#Dropbox)</code>  
<a name="Dropbox.stats"></a>

### Dropbox.stats
Stats object will have up to date statistical information about the requests that
have been made so far.

**Kind**: static property of <code>[Dropbox](#Dropbox)</code>  

* [.stats](#Dropbox.stats)
    * [.flight](#Dropbox.stats.flight)
    * [.pending](#Dropbox.stats.pending)
    * [.completed](#Dropbox.stats.completed)
    * [.errors](#Dropbox.stats.errors)
    * [.retries](#Dropbox.stats.retries)

<a name="Dropbox.stats.flight"></a>

#### stats.flight
Stats on how many requests are on actually sent and on the fly. The rest of may be queued up
by the throttler.

**Kind**: static property of <code>[stats](#Dropbox.stats)</code>  
**See**: [pending](#Dropbox.stats.pending)  
<a name="Dropbox.stats.pending"></a>

#### stats.pending
Stats on how many requests are pending.

**Kind**: static property of <code>[stats](#Dropbox.stats)</code>  
<a name="Dropbox.stats.completed"></a>

#### stats.completed
Stats on how many requests successfully completed.

**Kind**: static property of <code>[stats](#Dropbox.stats)</code>  
<a name="Dropbox.stats.errors"></a>

#### stats.errors
Stats on how many requests actually endded up being a failure despite all the effort (just like you).

**Kind**: static property of <code>[stats](#Dropbox.stats)</code>  
<a name="Dropbox.stats.retries"></a>

#### stats.retries
Stats on how many times requests have been retried.

**Kind**: static property of <code>[stats](#Dropbox.stats)</code>  
<a name="Dropbox.rawRequest"></a>

### Dropbox.rawRequest(options, emit, stats) ⇒ <code>Promise.&lt;Object&gt;</code>
Low level request API.

Use higher level methods instead.

**Kind**: static method of <code>[Dropbox](#Dropbox)</code>  
**Returns**: <code>Promise.&lt;Object&gt;</code> - Resolves with the response body (for rpcRequests)
Rejects with {Dropbox.RequestError}  
**See**

- [rpcRequest](#Dropbox.rpcRequest)
- [download](#Dropbox.download)
- [upload](#Dropbox.upload)


| Param | Type | Description |
| --- | --- | --- |
| options | <code>object</code> | {<br>  accessToken: {string},<br>  uri: {string},<br>  upload: {string\|Readable},<br>  download: {string\|Writable},<br>  parameters: {Object}<br> } |
| emit | <code>EventEmitter2.emit</code> | Emit function. |
| stats | <code>Object</code> | Custom stat object |

<a name="Dropbox.rpcRequest"></a>

### Dropbox.rpcRequest(accessToken, endpoint, parameters, [emit]) ⇒ <code>Promise</code>
Dropbox RPC request

**Kind**: static method of <code>[Dropbox](#Dropbox)</code>  
**Returns**: <code>Promise</code> - See rawRequest  

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| accessToken | <code>string</code> |  |  |
| endpoint | <code>string</code> |  | Endpoint without the preceeding slash, ex: 'users/get_account' |
| parameters | <code>object</code> |  |  |
| [emit] | <code>any</code> | <code>Dropbox.events.emit.bind(Dropbox.events)</code> |  |

<a name="Dropbox.download"></a>

### Dropbox.download(accessToken, src, dst, options) ⇒ <code>Promise</code>
Downloads a file to a writable stream.

Note:
Previously destination was strictly a strem.Writable, it provided the flexibility to
download to Buffer streams or anything streamy but that requires file descriptors
to be opened before being passed to DropboxUer.download().
Then the requests were throttled and downloaded accordingly. During this
whole process, file descriptors were closed one by one as the downloads
are completed. So, if you were to queue 20k downloads, 20k file descriptors
would be opened initially (it can't be since most OSes won't let you).
So, instead, we have to add support to a less elegant API, and support receiving
destination file as a path too. In this case, file descriptor is only opened when
the actual download starts.

**Kind**: static method of <code>[Dropbox](#Dropbox)</code>  
**Returns**: <code>Promise</code> - A promise that resolves to destionation stream  

| Param | Type | Description |
| --- | --- | --- |
| accessToken | <code>string</code> |  |
| src | <code>string</code> | Dropbox src identifier (could be path or id) |
| dst | <code>string</code> &#124; <code>stream.Writable</code> | Path or Writable stream to save the downloaded file to. |
| options | <code>object</code> | Dropbox options |

<a name="Dropbox.upload"></a>

### Dropbox.upload(accessToken, src, dstPath, parameters) ⇒ <code>Promise</code>
Uploads a file to the cloud.

https://www.dropbox.com/developers/documentation/http/documentation#files-upload

**Kind**: static method of <code>[Dropbox](#Dropbox)</code>  
**Returns**: <code>Promise</code> - A promise that resolves to undefined  

| Param | Type | Description |
| --- | --- | --- |
| accessToken | <code>string</code> | Access token |
| src | <code>string</code> &#124; <code>stream.Readable</code> | Readable stream to upload |
| dstPath | <code>string</code> | Upload destination |
| parameters | <code>object</code> | Dropbox options |


<a name="Sync"></a>

## Sync ⇐ <code>EventEmitter2</code>
**Kind**: global class  
**Extends:** <code>EventEmitter2</code>  

* [Sync](#Sync) ⇐ <code>EventEmitter2</code>
    * [new Sync()](#new_Sync_new)
    * [new Sync(folder, accessToken)](#new_Sync_new)
    * [.getCursor()](#Sync+getCursor) ⇒ <code>Promise.&lt;string&gt;</code>
    * [.getAccessToken()](#Sync+getAccessToken) ⇒ <code>Promise.&lt;string, Sync.Error&gt;</code>
    * [.sync(filter)](#Sync+sync) ⇒ <code>Promise</code>
    * [.delta(cursor)](#Sync+delta) ⇒ <code>object</code>

<a name="new_Sync_new"></a>

### new Sync()
One way Dropbox Sync client.

It only supports cloud to local syncing as of now.

It will create two additional files during first call to [sync](#Sync+sync).

<a name="new_Sync_new"></a>

### new Sync(folder, accessToken)
Creates an instance of Sync.


| Param | Type | Description |
| --- | --- | --- |
| folder | <code>string</code> | Local folder path |
| accessToken | <code>string</code> | Access token for the user |

<a name="Sync+getCursor"></a>

### sync.getCursor() ⇒ <code>Promise.&lt;string&gt;</code>
**Kind**: instance method of <code>[Sync](#Sync)</code>  
**Returns**: <code>Promise.&lt;string&gt;</code> - The last saved cursor, null if there is none.  
<a name="Sync+getAccessToken"></a>

### sync.getAccessToken() ⇒ <code>Promise.&lt;string, Sync.Error&gt;</code>
This method uses an instance variable accessTokenCache to cache the access token
as it might be used quite frequently.

So, if you want to invalidate the cache simply delete the instance variable accessTokenCache.

**Kind**: instance method of <code>[Sync](#Sync)</code>  
**Returns**: <code>Promise.&lt;string, Sync.Error&gt;</code> - Current access token for this sync point.  
<a name="Sync+sync"></a>

### sync.sync(filter) ⇒ <code>Promise</code>
**Kind**: instance method of <code>[Sync](#Sync)</code>  
**Returns**: <code>Promise</code> - A Promise that resolves to an object
{
        folders  : <array of folder entries that are created>,
        deletes  : <array of file entries that got deleted>,
        downloads: <array of file entries that got downloaded>,
        ignored  : <array of file entries that are ignored>
      }  

| Param | Type | Description |
| --- | --- | --- |
| filter | <code>function</code> | is called with file object and the object is processed                   only if this function returns true. Can be used to skip                   file downloads, directory creations and file deletions.                   Object is {'.tag': <folder|file|deleted>,                              name  : <file name>,                              path_lower: <lower case path>,                              path_display: <path>,                              id: <dropbox file id>} |

<a name="Sync+delta"></a>

### sync.delta(cursor) ⇒ <code>object</code>
Returns a delta since the last cursor.

Cursor file is located in DropboxUser.USERS_DIR/{accountId}/cursor

This method does not update the cursor file itself. It's user's responsibility
to update the cursor file, possible after completing a task (such as sync) succesfully.

Once the caller of this method (@see DropboxUser.sync()) saves the returned cursor, the next call to
delta will return the changes from that cursor and the entries returned in the
current call will be lost.

**Kind**: instance method of <code>[Sync](#Sync)</code>  
**Returns**: <code>object</code> - An object with allEntries property which holds an array
                 of all the entries since the last cursor saved.
                 Also has a .cursor property. It's caller's responsibility
                 to save the new cursor (probably after doing some work successfuly)  

| Param | Type | Description |
| --- | --- | --- |
| cursor | <code>string</code> | Last cursor to get the delta from. null if you don't have a cursor                  and want to get the delta from the very beginning. |

