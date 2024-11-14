const StratumServer = require('./StratumServer');
const RPCClient = require('./RPCClient');
const crypto = require('crypto');
const events = require('events');

const port = 5041;
const rpcHost = "http://10.0.0.186:27486/";
const rpcUser = "node";
const rpcPass = "1234";

// Configuration
const DIFFICULTY_TARGET_SHARES = 22;
const DIFFICULTY_RETARGET_TIME = 60;
const MIN_DIFFICULTY = 5000;
const MAX_DIFFICULTY = 1000000;
const VARDIFF_TIME_BUFFER = 4;

class MiningPool extends events.EventEmitter {
    constructor() {
        super();
        this.server = new StratumServer(port);
        this.rpc = new RPCClient(rpcUser, rpcPass, rpcHost);
        this.users = new Map();
        this.jobs = new Map();
        this.currentBlockTemplate = null;

        this.initializeServer();
    }

    createMinerInstance(socket) {
        return {
            socket,
            difficulty: MIN_DIFFICULTY,
            validShares: 0,
            invalidShares: 0,
            lastShareTime: Date.now(),
            submissions: [],
            connected: Date.now(),
            authorized: false,
            username: null
        };
    }

    generateJobId() {
        return crypto.randomBytes(4).toString('hex');
    }

    async createJob(blockTemplate, cleanJobs = true) {
        const jobId = this.generateJobId();
        const merkleRoot = this.calculateMerkleRoot([
            blockTemplate.coinbasetxn.hash,
            ...blockTemplate.transactions.map(tx => tx.hash)
        ]);

        const job = {
            id: jobId,
            height: blockTemplate.height,
            previousBlockHash: blockTemplate.previousblockhash,
            coinbase1: blockTemplate.coinbasetxn.data,
            merkleRoot,
            version: blockTemplate.version,
            bits: blockTemplate.bits,
            target: blockTemplate.target,
            curTime: blockTemplate.curtime,
            finalsaplingroot: blockTemplate.finalsaplingroothash,
            cleanJobs,
            submissions: new Set()
        };

        this.jobs.set(jobId, job);
        return job;
    }

    adjustMinerDifficulty(miner) {
        const now = Date.now();
        const timeElapsed = (now - miner.lastShareTime) / 1000;
        if (timeElapsed < DIFFICULTY_RETARGET_TIME - VARDIFF_TIME_BUFFER) return;

        const sharesPerMin = (miner.validShares * 60) / timeElapsed;
        let newDifficulty = miner.difficulty;

        if (sharesPerMin < DIFFICULTY_TARGET_SHARES - 1) {
            newDifficulty = Math.max(MIN_DIFFICULTY, miner.difficulty * 0.8);
        } else if (sharesPerMin > DIFFICULTY_TARGET_SHARES + 1) {
            newDifficulty = Math.min(MAX_DIFFICULTY, miner.difficulty * 1.2);
        }

        if (newDifficulty !== miner.difficulty) {
            miner.difficulty = newDifficulty;
            this.sendDifficultyUpdate(miner);
        }

        miner.validShares = 0;
        miner.lastShareTime = now;
    }

    async sendDifficultyUpdate(miner) {
        // Convert difficulty to a 256-bit hex target
        const target = this.encodeDifficulty(miner.difficulty);

        const message = {
            id: null,
            method: 'mining.set_difficulty',
            params: [target]
        };

        await this.server.send(miner.socket, message);
    }

    async encodeDifficulty(difficulty) {
        // Maximum possible target for difficulty 1 is v
        const maxTarget = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');

        // Calculate target based on the difficulty (inverse relationship)
        const target = maxTarget / BigInt(difficulty);

        // Convert target to a 256-bit hexadecimal string
        const targetHex = target.toString(16).padStart(64, '0');
        console.log(`${targetHex}`);
        return targetHex;
    }

    async sendJob(miner, job, cleanJobs = false) {
        const message = {
            id: null,
            method: 'mining.notify',
            params: [
                job.id,
                job.version.toString(16).padStart(8, '0'),
                this.reverseHex(job.previousBlockHash),
                job.merkleRoot,
                job.finalsaplingroot,
                this.reverseHex(job.curTime.toString(16).padStart(8, '0')),
                this.reverseHex(job.bits),
                cleanJobs,
                job.coinbase1
            ]
        };
        await this.server.send(miner.socket, message);
    }

    async handleBlockNotify(blockhash) {
        try {
            const blockTemplate = await this.rpc.callRPC("getblocktemplate", []);
            if (blockTemplate === this.currentBlockTemplate) {
                return;
            }

            this.currentBlockTemplate = blockTemplate;
            const job = await this.createJob(blockTemplate, true);

            for (const [_, miner] of this.users) {
                await this.sendJob(miner, job, true);
            }

            this.log(`New block detected: ${blockhash}, height: ${blockTemplate.height}`);
        } catch (error) {
            this.log(`Error processing block notification: ${error.message}`, 'error');
        }
    }

    async handleAuthorize(socket, message) {
        const minerKey = `${socket.remoteAddress}:${socket.remotePort}`;
        const minerInstance = this.users.get(minerKey);

        if (!minerInstance) {
            this.log(`Authorization attempt from unknown miner: ${minerKey}`, 'warning');
            return;
        }

        const [username, password] = message.params;

        const authorized = true;

        const response = {
            id: message.id,
            result: authorized,
            error: null
        };

        if (authorized) {
            minerInstance.authorized = true;
            minerInstance.username = username;
            this.log(`Miner ${username} (${minerKey}) authorized successfully`);
            //send first job on connection
            await this.sendDifficultyUpdate(minerInstance);
            const blockTemplate = await this.rpc.callRPC("getblocktemplate", []);
            const job = await this.createJob(blockTemplate, true);
            await this.sendJob(minerInstance.socket, job, true);

        } else {
            this.log(`Failed authorization attempt from ${minerKey}`, 'warning');
        }

        await this.server.send(socket, response);
    }

    async handleSubmit(socket, message) {
        const minerKey = `${socket.remoteAddress}:${socket.remotePort}`;
        const minerInstance = this.users.get(minerKey);

        if (!minerInstance || !minerInstance.authorized) {
            this.log(`Unauthorized submit from ${minerKey}`, 'warning');
            return;
        }

        const [workerName, jobId, timeHex, nonceStr, solHex] = message.params;
        const job = this.jobs.get(jobId);

        if (!job) {
            await this.server.send(socket, {
                id: message.id,
                result: null,
                error: [21, 'Job not found', null]
            });
            return;
        }

        // Check for duplicate submission
        const submissionKey = `${jobId}:${nonceStr}:${solHex}`;
        if (job.submissions.has(submissionKey)) {
            await this.server.send(socket, {
                id: message.id,
                result: null,
                error: [22, 'Duplicate share', null]
            });
            return;
        }

        job.submissions.add(submissionKey);

        try {
            // Submit share to node for verification
            const shareResponse = await this.rpc.callRPC('submitblock', {
                jobId,
                time: timeHex,
                nonce: nonceStr,
                solution: solHex
            });

            if (shareResponse.valid) {
                minerInstance.validShares++;
                this.adjustMinerDifficulty(minerInstance);

                // If share response indicates it's also a valid block
                if (shareResponse.isBlock) {
                    try {
                        await this.rpc.submitBlock(shareResponse.blockHex);
                        this.log(`Block found by ${minerInstance.username}!`, 'success');
                    } catch (error) {
                        this.log(`Error submitting block: ${error.message}`, 'error');
                    }
                }

                await this.server.send(socket, {
                    id: message.id,
                    result: true,
                    error: null
                });

                this.log(`Valid share from ${minerInstance.username} (diff: ${minerInstance.difficulty})`);
            } else {
                minerInstance.invalidShares++;
                await this.server.send(socket, {
                    id: message.id,
                    result: null,
                    error: [20, 'Invalid share', null]
                });

                this.log(`Invalid share from ${minerInstance.username}`, 'warning');
            }
        } catch (error) {
            this.log(`Error processing share: ${error.message}`, 'error');
            await this.server.send(socket, {
                id: message.id,
                result: null,
                error: [20, 'Share verification error', null]
            });
        }
    }

    initializeServer() {
        this.server.on('connection', (socket) => this.handleNewConnection(socket));
        this.server.on('mining.subscribe', (socket, message) => this.handleSubscribe(socket, message));
        this.server.on('mining.authorize', (socket, message) => this.handleAuthorize(socket, message));
        this.server.on('mining.submit', (socket, message) => this.handleSubmit(socket, message));
        this.server.on('mining.extranonce.subscribe', () => {})

        this.server.start();
        this.log(`Mining Pool Server started on port ${port}`);
    }

    async handleNewConnection(socket) {
        const miner = `${socket.remoteAddress}:${socket.remotePort}`;
        const minerInstance = this.createMinerInstance(socket);
        this.users.set(miner, minerInstance);
        this.log(`New miner connected: ${miner}`);

        socket.on('error', (error) => {
            this.log(`Socket error from ${miner}: ${error.message}`, 'error');
            this.users.delete(miner);
        });

        socket.on('close', () => {
            this.log(`Connection closed: ${miner}`, 'info');
            this.users.delete(miner);
        });
    }

    async handleSubscribe(socket, message) {
        const minerKey = `${socket.remoteAddress}:${socket.remotePort}`;
        let minerInstance = this.users.get(minerKey);

        if (!minerInstance) {
            minerInstance = this.createMinerInstance(socket);
            this.users.set(minerKey, minerInstance);
        }

        const response = {
            id: message.id,
            result: [
                [
                    ["mining.set_difficulty", `${minerKey}_diff`],
                    ["mining.notify", `${minerKey}_notify`]
                ]
            ],
            error: null
        };

        await this.server.send(socket, response);
    }

    getTimestamp() {
        return new Date().toISOString();
    }

    reverseHex(hex) {
        return hex.match(/.{2}/g).reverse().join('');
    }

    log(message, type = 'info') {
        const timestamp = this.getTimestamp();
        console.log(`${timestamp} | ${type.toUpperCase()} | ${message}`);
    }

    calculateMerkleRoot(hashes) {
        if (!Array.isArray(hashes) || hashes.length === 0) {
            throw new Error('Invalid hashes array provided for merkle root calculation');
        }
        if (hashes.length === 1) return hashes[0];

        const newHashes = [];
        for (let i = 0; i < hashes.length; i += 2) {
            const hashPair = hashes[i] + (hashes[i + 1] || hashes[i]);
            newHashes.push(crypto.createHash('sha256').update(hashPair).digest('hex'));
        }
        return this.calculateMerkleRoot(newHashes);
    }
}

// Initialize and export the pool
const pool = new MiningPool();

// Export method for block notifications
module.exports = {
    notifyBlock: (blockhash) => pool.handleBlockNotify(blockhash),
    pool
};