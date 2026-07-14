import TcpSocket from 'react-native-tcp-socket';
import BackgroundService from 'react-native-background-actions';
import {modelStore} from '../store/ModelStore';

class HttpServer {
  server: any;
  port!: number;
  host!: string;
  onRequest: (req: any, res: any) => void;

  constructor(onRequest: (req: any, res: any) => void) {
    this.onRequest = onRequest;
  }

  listen(port: number, host: string, callback: () => void) {
    this.port = port;
    this.host = host;

    this.server = TcpSocket.createServer(socket => {
      let buffer = '';
      socket.on('data', data => {
        buffer += data.toString();
        this.parseRequest(buffer, socket);
      });
      socket.on('error', error => {
        console.error('Socket error:', error);
      });
    });

    this.server.listen({port, host}, callback);
  }

  close() {
    if (this.server) {
      this.server.close();
    }
  }

  parseRequest(buffer: string, socket: any) {
    const headersEnd = buffer.indexOf('\r\n\r\n');
    if (headersEnd !== -1) {
      const headerText = buffer.substring(0, headersEnd);
      const body = buffer.substring(headersEnd + 4);

      const lines = headerText.split('\r\n');
      const [method, url] = lines[0].split(' ');

      let headers: any = {};
      for (let i = 1; i < lines.length; i++) {
        const [key, ...value] = lines[i].split(':');
        if (key && value.length > 0) {
          headers[key.trim().toLowerCase()] = value.join(':').trim();
        }
      }

      const contentLength = parseInt(headers['content-length'] || '0', 10);
      if (body.length >= contentLength) {
        const req = {
          method,
          url,
          headers,
          body: body.substring(0, contentLength),
        };

        const res = {
          socket,
          writeHead: (statusCode: number, resHeaders: any) => {
            let response = `HTTP/1.1 ${statusCode} OK\r\n`;
            for (const [key, value] of Object.entries(resHeaders)) {
              response += `${key}: ${value}\r\n`;
            }
            response += '\r\n';
            socket.write(response);
          },
          write: (data: string) => {
            socket.write(data);
          },
          end: (data?: string) => {
            if (data) {
              socket.write(data);
            }
            socket.end();
          },
        };

        this.onRequest(req, res);
      }
    }
  }
}

class LlmServer {
  server: HttpServer | null = null;
  isRunning = false;

  async start(port: number, exposeToLan: boolean = false) {
    if (this.isRunning) return;

    const host = exposeToLan ? '0.0.0.0' : '127.0.0.1';

    this.server = new HttpServer(this.handleRequest.bind(this));

    return new Promise<void>((resolve, reject) => {
      try {
        this.server?.listen(port, host, () => {
          this.isRunning = true;
          this.startBackgroundService();
          resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  async stop() {
    if (!this.isRunning) return;

    this.server?.close();
    this.server = null;
    this.isRunning = false;
    await BackgroundService.stop();
  }

  async startBackgroundService() {
    const sleep = (time: number) =>
      new Promise<void>(resolve => setTimeout(() => resolve(), time));
    const task = async () => {
      while (this.isRunning) {
        await sleep(1000);
      }
    };

    const options = {
      taskName: 'LlmServer',
      taskTitle: 'LLM Server Running',
      taskDesc: 'The local LLM server is running in the background.',
      taskIcon: {
        name: 'ic_launcher',
        type: 'mipmap',
      },
      color: '#ff00ff',
      linkingURI: 'yourSchemeHere://chat/jane',
      parameters: {
        delay: 1000,
      },
    };

    await BackgroundService.start(task, options);
  }

  async handleRequest(req: any, res: any) {
    try {
      if (
        req.method === 'GET' &&
        (req.url === '/v1/models' || req.url === '/api/tags')
      ) {
        this.handleModels(req, res);
      } else if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        await this.handleChatCompletions(req, res);
      } else if (req.method === 'POST' && req.url === '/api/chat') {
        await this.handleOllamaChat(req, res);
      } else if (req.method === 'POST' && req.url === '/api/generate') {
        await this.handleOllamaGenerate(req, res);
      } else {
        res.writeHead(404, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: 'Not found'}));
      }
    } catch (e: any) {
      console.error('LLM Server error:', e);
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: e.message || 'Internal Server Error'}));
    }
  }

  handleModels(req: any, res: any) {
    const isOllama = req.url === '/api/tags';

    const activeModel = modelStore.activeModel;
    if (!activeModel) {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify(isOllama ? {models: []} : {object: 'list', data: []}),
      );
      return;
    }

    if (isOllama) {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          models: [
            {
              name: activeModel.name,
              model: activeModel.name,
              modified_at: new Date().toISOString(),
              size: activeModel.size || 0,
              digest: activeModel.id,
              details: {
                format: 'gguf',
                family: 'llama',
                families: ['llama'],
                parameter_size: 'unknown',
                quantization_level: 'unknown',
              },
            },
          ],
        }),
      );
    } else {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            {
              id: activeModel.name,
              object: 'model',
              created: Math.floor(Date.now() / 1000),
              owned_by: 'pocketpal',
            },
          ],
        }),
      );
    }
  }

  async handleChatCompletions(req: any, res: any) {
    if (!modelStore.context) {
      res.writeHead(400, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({
          error: {
            message: 'No model is currently loaded in the app.',
            type: 'invalid_request_error',
          },
        }),
      );
      return;
    }

    const body = JSON.parse(req.body);
    const stream = body.stream === true;

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      let responseId =
        'chatcmpl-' + Math.random().toString(36).substring(2, 15);
      let created = Math.floor(Date.now() / 1000);
      let model = body.model || modelStore.activeModel?.name || 'local-model';

      try {
        await modelStore.context.completion(
          {
            messages: body.messages,
            temperature: body.temperature ?? 0.7,
            n_predict: body.max_tokens ?? 2048,
            top_p: body.top_p ?? 1.0,
            stop: body.stop,
          },
          (data: any) => {
            const chunk = {
              id: responseId,
              object: 'chat.completion.chunk',
              created: created,
              model: model,
              choices: [
                {
                  index: 0,
                  delta: {
                    content: data.token,
                  },
                  finish_reason: null,
                },
              ],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          },
        );

        res.write(
          `data: ${JSON.stringify({
            id: responseId,
            object: 'chat.completion.chunk',
            created: created,
            model: model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: 'stop',
              },
            ],
          })}\n\n`,
        );
        res.write(`data: [DONE]\n\n`);
        res.end();
      } catch (e: any) {
        res.write(`data: ${JSON.stringify({error: e.message})}\n\n`);
        res.end();
      }
    } else {
      try {
        const completionResult = await modelStore.context.completion({
          messages: body.messages,
          temperature: body.temperature ?? 0.7,
          n_predict: body.max_tokens ?? 2048,
          top_p: body.top_p ?? 1.0,
          stop: body.stop,
        });

        const response = {
          id: 'chatcmpl-' + Math.random().toString(36).substring(2, 15),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model || modelStore.activeModel?.name || 'local-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: completionResult.text,
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: completionResult.timings?.prompt_n || 0,
            completion_tokens: completionResult.timings?.predicted_n || 0,
            total_tokens:
              (completionResult.timings?.prompt_n || 0) +
              (completionResult.timings?.predicted_n || 0),
          },
        };

        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(response));
      } catch (e: any) {
        res.writeHead(500, {'Content-Type': 'application/json'});
        res.end(
          JSON.stringify({error: {message: e.message, type: 'server_error'}}),
        );
      }
    }
  }

  async handleOllamaChat(req: any, res: any) {
    if (!modelStore.context) {
      res.writeHead(400, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({error: 'No model is currently loaded in the app.'}),
      );
      return;
    }

    const body = JSON.parse(req.body);
    const stream = body.stream !== false;

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      let model = body.model || modelStore.activeModel?.name || 'local-model';

      try {
        const completionResult = await modelStore.context.completion(
          {
            messages: body.messages,
            temperature: body.options?.temperature ?? 0.7,
            n_predict: body.options?.num_predict ?? 2048,
            top_p: body.options?.top_p ?? 1.0,
            stop: body.options?.stop,
          },
          (data: any) => {
            const chunk = {
              model: model,
              created_at: new Date().toISOString(),
              message: {
                role: 'assistant',
                content: data.token,
              },
              done: false,
            };
            res.write(`${JSON.stringify(chunk)}\n`);
          },
        );

        res.write(
          `${JSON.stringify({
            model: model,
            created_at: new Date().toISOString(),
            message: {
              role: 'assistant',
              content: '',
            },
            done: true,
            done_reason: 'stop',
            eval_count: completionResult.timings?.predicted_n || 0,
            prompt_eval_count: completionResult.timings?.prompt_n || 0,
          })}\n`,
        );
        res.end();
      } catch (e: any) {
        res.write(`${JSON.stringify({error: e.message, done: true})}\n`);
        res.end();
      }
    } else {
      try {
        const completionResult = await modelStore.context.completion({
          messages: body.messages,
          temperature: body.options?.temperature ?? 0.7,
          n_predict: body.options?.num_predict ?? 2048,
          top_p: body.options?.top_p ?? 1.0,
          stop: body.options?.stop,
        });

        const response = {
          model: body.model || modelStore.activeModel?.name || 'local-model',
          created_at: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: completionResult.text,
          },
          done: true,
          done_reason: 'stop',
          eval_count: completionResult.timings?.predicted_n || 0,
          prompt_eval_count: completionResult.timings?.prompt_n || 0,
        };

        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(response));
      } catch (e: any) {
        res.writeHead(500, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: e.message}));
      }
    }
  }

  async handleOllamaGenerate(req: any, res: any) {
    if (!modelStore.context) {
      res.writeHead(400, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify({error: 'No model is currently loaded in the app.'}),
      );
      return;
    }

    const body = JSON.parse(req.body);
    const stream = body.stream !== false;

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      let model = body.model || modelStore.activeModel?.name || 'local-model';

      try {
        const completionResult = await modelStore.context.completion(
          {
            prompt: body.prompt,
            temperature: body.options?.temperature ?? 0.7,
            n_predict: body.options?.num_predict ?? 2048,
            top_p: body.options?.top_p ?? 1.0,
            stop: body.options?.stop,
          },
          (data: any) => {
            const chunk = {
              model: model,
              created_at: new Date().toISOString(),
              response: data.token,
              done: false,
            };
            res.write(`${JSON.stringify(chunk)}\n`);
          },
        );

        res.write(
          `${JSON.stringify({
            model: model,
            created_at: new Date().toISOString(),
            response: '',
            done: true,
            done_reason: 'stop',
            eval_count: completionResult.timings?.predicted_n || 0,
            prompt_eval_count: completionResult.timings?.prompt_n || 0,
          })}\n`,
        );
        res.end();
      } catch (e: any) {
        res.write(`${JSON.stringify({error: e.message, done: true})}\n`);
        res.end();
      }
    } else {
      try {
        const completionResult = await modelStore.context.completion({
          prompt: body.prompt,
          temperature: body.options?.temperature ?? 0.7,
          n_predict: body.options?.num_predict ?? 2048,
          top_p: body.options?.top_p ?? 1.0,
          stop: body.options?.stop,
        });

        const response = {
          model: body.model || modelStore.activeModel?.name || 'local-model',
          created_at: new Date().toISOString(),
          response: completionResult.text,
          done: true,
          done_reason: 'stop',
          eval_count: completionResult.timings?.predicted_n || 0,
          prompt_eval_count: completionResult.timings?.prompt_n || 0,
        };

        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(response));
      } catch (e: any) {
        res.writeHead(500, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: e.message}));
      }
    }
  }
}

export const llmServer = new LlmServer();
