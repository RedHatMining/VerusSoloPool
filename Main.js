const StratumServer = require('./StratumServer');
const RPCClient = require('./RPCClient');
const crypto = require('crypto');

class VerusPool {
    constructor(port = 5041, rpcHost = "http://10.0.0.141:27486/", rpcUser = "node", rpcPass = "1234") {
        this.server = new StratumServer(port);
        this.rpc = new RPCClient(rpcUser, rpcPass, rpcHost);
        this.users = new Map();
        this.activeJobs = new Map();
        
        this.initializeServer();
    }

    getTimestamp() {
        return new Date().toISOString();
    }

    log(message, type = 'info') {
        const timestamp = this.getTimestamp();
        console.log(`${timestamp} | ${type.toUpperCase()} | ${message}`);
    }

    calculateMerkleRoot(hashes) {
        if (!Array.isArray(hashes)) {
            throw new Error('Invalid hashes array provided for merkle root calculation');
        }
        if (hashes.length <= 1) return hashes[0] || '';
        
        const newHashes = [];
        for (let i = 0; i < hashes.length; i += 2) {
            newHashes.push(hashes[i] + (hashes[i + 1] || hashes[i]));
        }
        return this.calculateMerkleRoot(newHashes);
    }

    generateExtraNonce() {
        try {
            const characters = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
            const randomValues = crypto.randomBytes(12);
            return [...randomValues].map(byte => characters[byte % characters.length]).join('');
        } catch (error) {
            this.log(`Error generating extraNonce: ${error.message}`, 'error');
            // Fallback to simpler random generation if crypto fails
            return Math.random().toString(36).substring(2, 14).toUpperCase();
        }
    }

    async sendWork(socket) {
        try {
            const blockTemplate = await this.rpc.getBlockTemplate();
            const miner = `${socket.remoteAddress}:${socket.remotePort}`;
            
            // Store job data for verification later
            const jobId = Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8, '0');
            this.activeJobs.set(jobId, {
                template: blockTemplate,
                timestamp: this.getTimestamp()
            });

            const reverseHex = hex => hex.match(/.{2}/g).reverse().join('');
            
            const notifyMessage = {
                'jsonrpc': '2.0',
                'method': 'mining.notify',
                'params': [
                    jobId,
                    blockTemplate.version.toString(16).padStart(8, '0'),
                    reverseHex(blockTemplate.previousblockhash),
                    this.calculateMerkleRoot([
                        blockTemplate.coinbasetxn.hash,
                        ...blockTemplate.transactions.map(tx => tx.hash)
                    ]).slice(0, 64),
                    blockTemplate.finalsaplingroothash,
                    reverseHex(blockTemplate.curtime.toString(16).padStart(8, '0')),
                    reverseHex(blockTemplate.bits),
                    true,
                    blockTemplate.coinbasetxn.data
                ],
                'id': null
            };

            await this.server.send(socket, notifyMessage);
            this.log(`Sent new work to miner ${miner} - Job ID: ${jobId}`);

        } catch (error) {
            this.log(`Failed to send work: ${error.message}`, 'error');
            throw error;
        }
    }

    async startupSequence(socket) {
        const miner = `${socket.remoteAddress}:${socket.remotePort}`;

        try {
            const blockData = await this.rpc.getBlockTemplate();
            
            // Send target
            const targetMessage = {
                'jsonrpc': '2.0',
                'method': 'mining.set_target',
                'params': [blockData.target],
                'id': null
            };
            await this.server.send(socket, targetMessage);
            this.log(`Set target to ${blockData.target} for miner ${miner}`);

            // Send initial work
            await this.sendWork(socket);

        } catch (error) {
            this.log(`Startup sequence failed for ${miner}: ${error.message}`, 'error');
            throw error;
        }
    }

    initializeServer() {
        this.server.on('connection', (socket) => {
            const miner = `${socket.remoteAddress}:${socket.remotePort}`;
            this.log(`New connection from ${miner}`);

            socket.on('error', (error) => {
                this.log(`Socket error from ${miner}: ${error.message}`, 'error');
            });

            socket.on('close', () => {
                this.log(`Connection closed: ${miner}`);
                this.users.delete(miner);
            });
        });

        this.server.on('mining.subscribe', async (socket, message) => {
            const miner = `${socket.remoteAddress}:${socket.remotePort}`;
            try {
                const minerProgram = message.params[0];
                const extranonce1 = message.params[1] || this.generateExtraNonce();
                
                this.log(`Miner ${miner} subscribed using ${minerProgram}`);

                const response = {
                    'result': [
                        extranonce1,
                        crypto.randomBytes(4).toString('hex')
                    ],
                    'id': message.id,
                    'error': null
                };
                
                await this.server.send(socket, response);
            } catch (error) {
                this.log(`Subscribe failed for ${miner}: ${error.message}`, 'error');
                const errorResponse = {
                    'result': null,
                    'error': [20, 'Subscribe failed', null],
                    'id': message.id
                };
                await this.server.send(socket, errorResponse);
            }
        });
		this.server.on('mining.extranonce.subscribe', () => {
			return
		})
        this.server.on('mining.authorize', async (socket, message) => {
            const miner = `${socket.remoteAddress}:${socket.remotePort}`;
            try {
                const username = message.params[0];
                this.users.set(miner, username);
                
                this.log(`Miner ${miner} authorized as ${username}`);

                const response = {
                    'result': true,
                    'id': message.id,
                    'error': null
                };
                
                await this.server.send(socket, response);

                const welcomeBanner = {
                    'id': null,
                    'method': 'client.show_message',
                    'params': ['Welcome to Zarina\'s Solo Mining Pool']
                };
                await this.server.send(socket, welcomeBanner);

                await this.startupSequence(socket);

            } catch (error) {
                this.log(`Authorization failed for ${miner}: ${error.message}`, 'error');
                const errorResponse = {
                    'result': false,
                    'error': [24, 'Authorization failed', null],
                    'id': message.id
                };
                await this.server.send(socket, errorResponse);
            }
        });

        this.server.on('mining.submit', async (socket, message) => {
            const miner = `${socket.remoteAddress}:${socket.remotePort}`;
            try {
                // Add share submission handling here
                this.log(`Share submitted by ${miner}`);
                
                const response = {
                    'result': true,
                    'error': null,
                    'id': message.id
                };
                await this.server.send(socket, response);
            } catch (error) {
                this.log(`Share submission failed for ${miner}: ${error.message}`, 'error');
                const errorResponse = {
                    'result': false,
                    'error': [25, 'Share rejected', null],
                    'id': message.id
                };
                await this.server.send(socket, errorResponse);
            }
        });

        this.server.start();
        this.log('Stratum server started successfully');
    }
}

// Start the pool
const pool = new VerusPool();