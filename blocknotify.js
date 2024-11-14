#!/usr/bin/env node
const { notifyBlock } = require('Main.js');

// Get blockhash from command line argument
const blockhash = process.argv[2];
if (!blockhash) {
    console.error('No blockhash provided');
    process.exit(1);
}

notifyBlock(blockhash).catch(error => {
    console.error('Error processing block notification:', error);
    process.exit(1);
});
