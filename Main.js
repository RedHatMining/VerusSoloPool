const StratumServer = require('./StratumServer');
const RPCClient = require('./RPCClient');
const crypto = require('crypto');

const port = 5041;
const rpcHost = "http://10.0.0.151:27486/";
const rpcUser = "node";
const rpcPass = "1234";

const server = new StratumServer(port);
const rpc = new RPCClient(rpcUser, rpcPass, rpcHost);
const users = new Map();
let currentJob = null;

const getTimestamp = () => new Date().toISOString();
const reverseHex = hex => hex.match(/.{2}/g).reverse().join('');

const log = (message, type = 'info') => {
    console.log(`${getTimestamp()} | ${type.toUpperCase()} | ${message}`);
};

const calculateMerkleRoot = (hashes) => {
    if (!Array.isArray(hashes) || hashes.length === 0) {
        throw new Error('Invalid hashes array provided for merkle root calculation');
    }
    if (hashes.length === 1) return hashes[0];

    const newHashes = [];
    for (let i = 0; i < hashes.length; i += 2) {
        const hashPair = hashes[i] + (hashes[i + 1] || hashes[i]);
        newHashes.push(crypto.createHash('sha256').update(hashPair).digest('hex'));
    }
    return calculateMerkleRoot(newHashes);
};

const generateJobId = () => Math.floor(Math.random() * 0xFFFFFFF).toString(16).padStart(7, '0');

const generateExtraNonce = () => {
    const characters = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const randomValues = crypto.randomBytes(4); 
    return Array.from(randomValues)
        .map(byte => characters[byte % characters.length])
        .join('');
};

const fetchBlockTemplate = async (retryCount = 3) => {
    try {
        const blockTemplate = await rpc.getBlockTemplate();
        if (!blockTemplate || typeof blockTemplate !== 'object') {
            throw new Error('Invalid block template response');
        }
        return blockTemplate;
    } catch (error) {
        if (retryCount > 0) {
            log(`Error fetching block template: ${error.message}. Retrying... (${retryCount} attempts left)`, 'warn');
            return await fetchBlockTemplate(retryCount - 1);
        } else {
            log(`Failed to fetch block template after multiple attempts: ${error.message}`, 'error');
            throw error;
        }
    }
};

const submitBlock = async (block) => {
    try {
        const response = await rpc.submitBlock(block);
        if (!response || response.error) {
            throw new Error(`Failed to submit block: ${response.error || 'Unknown error'}`);
        }
        return response;
    } catch (error) {
        log(`Error submitting block: ${error.message}`, 'error');
        throw error;
    }
}

const sendWork = async (socket, miner, isNewJob = false) => {
    try {
        if (!currentJob) {
            log(`No active job for miner ${miner}`, 'error');
            return;
        }
        
        const blockTemplate = currentJob.template;
        const jobId = currentJob.id;
        
        const targetMessage = {
            jsonrpc: '2.0',
            method: 'mining.set_target',
            params: [reverseHex(blockTemplate.target)],
            id: null
        };
        
        await server.send(socket, targetMessage);

        const notifyMessage = {
            jsonrpc: '2.0',
            method: 'mining.notify',
            params: [
                jobId,
                blockTemplate.version.toString(16).padStart(8, '0'),
                reverseHex(blockTemplate.previousblockhash),
                calculateMerkleRoot([blockTemplate.coinbasetxn.hash, ...blockTemplate.transactions.map(tx => tx.hash)]).slice(0, 64),
                blockTemplate.finalsaplingroothash,
                reverseHex(blockTemplate.curtime.toString(16).padStart(8, '0')),
                reverseHex(blockTemplate.bits),
                true,
                blockTemplate.coinbasetxn.data
            ],
            id: null
        };

        await server.send(socket, notifyMessage);
		if (!isNewJob) {
        log(`Sent existing job to miner ${miner} - Job ID: ${jobId} - Target: ${reverseHex(blockTemplate.target)}`);
		}
    } catch (error) {
        log(`Error sending work to miner ${miner}: ${error.message}`, 'error');
    }
};

const handleNewConnection = async (socket) => {
    const miner = `${socket.remoteAddress}:${socket.remotePort}`;
    users.set(miner, socket);
    log(`New miner connected: ${miner}`);

    try {
        if (currentJob) {
            await sendWork(socket, miner, false);
        } else {
            await updateJob();
        }
    } catch (error) {
        log(`Error handling new connection for miner ${miner}: ${error.message}`, 'error');
    }

    socket.on('error', (error) => {
        log(`Socket error from ${miner}: ${error.message}`, 'error');
        users.delete(miner);
    });

    socket.on('close', () => {
        log(`Connection closed by miner ${miner}`, 'info');
        users.delete(miner);
    });
};

const handleSubscribe = async (socket, message) => {
    const miner = `${socket.remoteAddress}:${socket.remotePort}`;
    const extranonce1 = generateExtraNonce();
    
    log(`Miner ${miner} subscribed`);

    const response = {
        result: [extranonce1, crypto.randomBytes(4).toString('hex')],
        id: message.id,
        error: null
    };

    try {
        await server.send(socket, response);
        await handleNewConnection(socket);
    } catch (error) {
        log(`Error handling subscription for miner ${miner}: ${error.message}`, 'error');
    }
};

const handleAuthorize = async (socket, message) => {
    const miner = `${socket.remoteAddress}:${socket.remotePort}`;
    const username = message.params[0];

    log(`Miner ${miner} authorized as ${username}`);
    const response = { result: true, id: message.id, error: null };

    try {
        await server.send(socket, response);
        await sendWelcomeMessage(socket);
        await updateJob();
    } catch (error) {
        log(`Error authorizing miner ${miner}: ${error.message}`, 'error');
    }
};

const sendWelcomeMessage = async (socket) => {
    const welcomeMessage = {
        id: null,
        method: 'client.show_message',
        params: ['Welcome to Zarina\'s Solo Mining Pool']
    };

    try {
        await server.send(socket, welcomeMessage);
    } catch (error) {
        log(`Error sending welcome message: ${error.message}`, 'error');
    }
};

const handleSubmit = async (socket, message) => {
    const miner = `${socket.remoteAddress}:${socket.remotePort}`;
    const jobData = currentJob;

    if (!jobData) {
        log(`No active job for miner ${miner}`, 'error');
        return;
    }

    // Extract values from the message
    const timeHex = message.params[2];
    const nonceStr = message.params[3];
    const solHex = message.params[4];

    try {
        // Build each part of the block header as hex strings
        const nVersion = jobData.template.version.toString(16).padStart(8, '0');                        // nVersion
        const hashPrevBlock = reverseHex(jobData.template.previousblockhash);                            // hashPrevBlock
        const merkleRoot = reverseHex(calculateMerkleRoot([jobData.template.coinbasetxn.hash, ...jobData.template.transactions.map(tx => tx.hash)]).slice(0, 64)); // hashMerkleRoot
        //const hashReserved = reverseHex(jobData.template.finalsaplingroothash || jobData.template.hashBlockCommitments); // hashReserved / hashBlockCommitments
        const nTime = reverseHex(timeHex.padStart(8, '0'));                                              // nTime
        const nBits = reverseHex(jobData.template.bits.padStart(8, '0'));                                // nBits
        const nNonce = nonceStr.padStart(8, '0');                                                        // nNonce
        const solutionSize = '05d0';                                                                     // solutionSize (1344 in little-endian)
        const solution = solHex;                                                                         // solution

        // Concatenate the parts to form the complete block header as a hex string
        const blockHeader = nVersion + hashPrevBlock + merkleRoot + nTime + nBits + nNonce + solutionSize + solution;

        // Print out the block header for debugging
        log(`Block header for miner ${miner}: ${blockHeader}`);

        // Submit the block
        const result = await submitBlock(blockHeader);
        log(`Block submitted by ${miner}: ${result}`);
    } catch (error) {
        log(`Error submitting share for miner ${miner}: ${error.message}`, 'error');
    }

    const response = { "result": true, "error": null, "id": message.id };
    await server.send(socket, response);
    log(`Share submitted by ${miner}`);
};

const updateJob = async () => {
    try {
        const blockTemplate = await fetchBlockTemplate();
        let miners = 0;

        if (currentJob &&
            currentJob.template.previousblockhash === blockTemplate.previousblockhash &&
            currentJob.target === reverseHex(blockTemplate.target)) {
            return; // No update needed; existing job can be reused
        }

        const jobId = generateJobId();
        currentJob = {
            id: jobId,
            template: blockTemplate,
            target: reverseHex(blockTemplate.target),
            timestamp: getTimestamp()
        };
        log(`New job created with Job ID: ${jobId}`);

        for (const [miner, socket] of users) {
            await sendWork(socket, miner, true);
            miners += 1;
        }
        
        if (miners > 0) {
            log(`Sent new job to ${miners} miner(s) - Job ID: ${currentJob.id}`, 'info');
        }
    } catch (error) {
        log(`Error updating job: ${error.message}`, 'error');
    }
};

server.on('connection', (socket) => {
    handleNewConnection(socket);

    socket.on('error', (error) => {
        const miner = `${socket.remoteAddress}:${socket.remotePort}`;
        log(`Socket error from ${miner}: ${error.message}`, 'error');
        users.delete(miner);
    });

    socket.on('close', () => {
        const miner = `${socket.remoteAddress}:${socket.remotePort}`;
        log(`Connection closed: ${miner}`, 'info');
        users.delete(miner);
    });
});

server.on('mining.subscribe', (socket, message) => handleSubscribe(socket, message));
server.on('mining.authorize', (socket, message) => handleAuthorize(socket, message));
server.on('mining.submit', (socket, message) => handleSubmit(socket, message));
server.on('mining.extranonce.subscribe', () => {});

server.start();
log(`Zarina's Solo Mining Pool Server started on port ${port}`);

setInterval(() => updateJob(), 100); // Every 0.1 seconds
