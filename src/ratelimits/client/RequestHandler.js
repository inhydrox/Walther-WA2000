const { resolve } = require('path');
const { Util } = require('discord.js');
const { constructData } = require('../RatelimitQueue.js');

const AsyncQueue = require(resolve(require.resolve('discord.js').replace('index.js', '/rest/AsyncQueue.js')));
const HTTPError = require(resolve(require.resolve('discord.js').replace('index.js', '/rest/HTTPError.js')));
const DiscordAPIError = require(resolve(require.resolve('discord.js').replace('index.js', '/rest/DiscordAPIError.js')));

/**
  * ReqeustHandler, the handler for the non-master process that executes the rest requests
  * @class RequestHandler
  */
class RequestHandler {
    /**
     * @param {RequestManager} manager The manager for this request handler
     * @param {string} hash The hash for this request handler
     * @param {Object} options The options for the API request from the router
     */
    constructor(manager, hash, { major }) {
        /**
         * The manager of this request handler
         * @type {RequestManager}
         */
        this.manager = manager;
        /**
         * The ratelimit hash of this request handler
         * @type {string}
         */
        this.hash = hash;
        /**
         * The ID of this request handler
         * @type {string}
         */
        this.id = `${hash}:${major}`;

        this.queue = new AsyncQueue();
    }

    static parseResponse(res) {
        if (res.headers.get('content-type').startsWith('application/json')) return res.json();
        return res.buffer();
    }

    get inactive() {
        return this.queue.remaining === 0;
    }
    
    async push(request) {
        await this.queue.wait();
        let res;
        try {
            res = await this.execute(request);
        } finally {
            this.queue.shift();
        }
        return res;
    }

    async execute(request) {
        // Let master process "pause" this request until master process says its safe to resume due to ratelimits
        await this.manager.send(this.id, this.hash, request.method, request.route);    
        // Perform the request
        let res;
        try {
            res = await request.make();
        } catch (error) {
            // Retry the specified number of times for request abortions
            if (request.retries === this.manager.client.options.retryLimit) {
                throw new HTTPError(error.message, error.constructor.name, error.status, request.method, request.path);
            }
            request.retries++;
            return this.execute(request);
        }
        let after;
        if (res.headers) {
            // Build ratelimit data for master process
            const data = constructData(request, res.headers);
            // Just incase I messed my ratelimit handling up, so you can avoid getting banned
            after = !isNaN(data.after) ? Number(data.after) * 1000 : -1;
            // Send ratelimit data, and wait for possible global ratelimit manager halt
            await this.manager.send(this.id, this.hash, request.method, request.route, data);
        }
        // Handle 2xx and 3xx responses
        if (res.ok) 
            // Nothing wrong with the request, proceed with the next one
            return RequestHandler.parseResponse(res);
        
        // Handle 4xx responses
        if (res.status >= 400 && res.status < 500) {
            // Handle ratelimited requests
            if (res.status === 429) {
                // A ratelimit was hit, You did something stupid @saya
                this.manager.client.emit('debug', 
                    'Encountered unexpected 429 ratelimit\n' + 
                    `  Hash:Major     : ${this.id}\n` + 
                    `  Request Route  : ${request.route}\n` + 
                    `  Retry After    : ${after}ms` 
                );
                // Retry after, but add 500ms on the top of original retry after
                await Util.delayFor(after + 500);
                return this.execute(request);
            }
            // Handle possible malformed requests
            let data;
            try {
                data = await RequestHandler.parseResponse(res);
            } catch (err) {
                throw new HTTPError(err.message, err.constructor.name, err.status, request.method, request.path);
            }
            throw new DiscordAPIError(request.path, data, request.method, res.status);
        }
        // Handle 5xx responses
        if (res.status >= 500 && res.status < 600) {
            // Retry the specified number of times for possible serverside issues
            if (request.retries === this.manager.client.options.retryLimit)
                throw new HTTPError(res.statusText, res.constructor.name, res.status, request.method, request.path);
            request.retries++;
            return this.execute(request);
        }
        // Fallback in the rare case a status code outside the range 200..=599 is returned
        return null;
    }
}

module.exports = RequestHandler;