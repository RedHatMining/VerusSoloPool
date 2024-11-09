// Import fetch for making HTTP requests
const fetch = require('node-fetch-commonjs');

// Define the class for Verus RPC interaction
class VerusRPC {
    constructor(rpcUser = "node", rpcPassword = "1234", url = "http://10.0.0.141:27486/") {
        this.rpcUser = rpcUser;
        this.rpcPassword = rpcPassword;
        this.url = url;
    }

    // Helper function to call the Verus JSON-RPC
    async callRPC(method, params = []) {
        const body = {
            jsonrpc: '1.0',
            id: 'verus',
            method,
            params
        };

        // Set up headers and authorization
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Basic ' + Buffer.from(`${this.rpcUser}:${this.rpcPassword}`).toString('base64')
        };

        try {
            const response = await fetch(this.url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });

            const result = await response.json();
            if (result.error) {
                throw new Error(result.error.message);
            }
            return result.result;
        } catch (error) {
            console.error('RPC call error:', error.message);
            throw error;
        }
    }

    // Method to get the block template
    async getBlockTemplate() {
        return await this.callRPC('getblocktemplate', []);
    }

    // Method to submit a block
    async submitBlock(blockData) {
        return await this.callRPC('submitblock', [blockData]);
    }
}

module.exports = VerusRPC;
