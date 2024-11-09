const net = require('net');

class StratumServer {
  constructor(port, host = '10.0.0.77') {
    this.port = port;
    this.host = host;
    this.clients = [];
    this.messageHandlers = {};
    this.connectionHandler = null;
  }

  start() {
    this.server = net.createServer((socket) => {
      this.clients.push(socket);

      if (this.connectionHandler) {
        this.connectionHandler(socket);
      }

      socket.on('data', (data) => {
        // Split incoming data on newlines to handle each JSON message
        const messages = data.toString().split('\n').filter((msg) => msg.trim().length > 0);

        messages.forEach((message) => {
          this.handleMessage(socket, message);
        });
      });

      socket.on('end', () => {
        this.clients = this.clients.filter((client) => client !== socket);
      });

      socket.on('error', (err) => {
        console.error(`Socket error: ${err.message}`);
      });
    });

    this.server.listen(this.port, this.host, () => {
      console.log(`Stratum server started on ${this.host}:${this.port}`);
    });
  }

  onConnection(handler) {
    this.connectionHandler = handler;
  }

  handleMessage(socket, message) {
    try {
      const json = JSON.parse(message);
      if (json.method && this.messageHandlers[json.method]) {
        this.messageHandlers[json.method](socket, json);
      } else {
        console.warn(`Unhandled method: ${json.method}`);
      }
    } catch (err) {
      console.error(`Error parsing message: ${message} - ${err.message}`);
    }
  }

  on(method, handler) {
    this.messageHandlers[method] = handler;
  }

  send(socket, message) {
    const jsonMessage = JSON.stringify(message);
    socket.write(`${jsonMessage}\n`);
  }

  broadcast(message) {
    const jsonMessage = JSON.stringify(message);
    this.clients.forEach((client) => client.write(`${jsonMessage}\n`));
  }

  stop() {
    this.server.close(() => {
      console.log('Stratum server stopped');
    });
  }
}

module.exports = StratumServer;
