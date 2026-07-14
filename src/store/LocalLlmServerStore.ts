import {action, makeAutoObservable} from 'mobx';
import {makePersistable} from 'mobx-persist-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {llmServer} from '../utils/LlmServer';
import DeviceInfo from 'react-native-device-info';

class LocalLlmServerStore {
  isRunning = false;
  port = 8080;
  exposeToLan = false;
  ipAddress = '127.0.0.1';
  error: string | null = null;

  constructor() {
    makeAutoObservable(this);
    makePersistable(this, {
      name: 'LocalLlmServerStore',
      properties: ['port', 'exposeToLan'],
      storage: AsyncStorage,
    }).then(() => {
      this.updateIpAddress();
    });
  }

  updateIpAddress = async () => {
    try {
      const ip = await DeviceInfo.getIpAddress();
      this.setIpAddress(ip || '127.0.0.1');
    } catch (e) {
      console.error('Failed to get IP address:', e);
      this.setIpAddress('127.0.0.1');
    }
  };

  setIpAddress = action((ip: string) => {
    this.ipAddress = ip;
  });

  setPort = action((port: number) => {
    this.port = port;
  });

  setExposeToLan = action((expose: boolean) => {
    this.exposeToLan = expose;
    if (this.isRunning) {
      this.stopServer().then(() => this.startServer());
    }
  });

  setError = action((error: string | null) => {
    this.error = error;
  });

  setIsRunning = action((isRunning: boolean) => {
    this.isRunning = isRunning;
  });

  startServer = async () => {
    this.setError(null);
    try {
      await this.updateIpAddress();
      await llmServer.start(this.port, this.exposeToLan);
      this.setIsRunning(true);
    } catch (e: any) {
      console.error('Failed to start LLM server:', e);
      this.setError(e.message || 'Failed to start server');
      this.setIsRunning(false);
    }
  };

  stopServer = async () => {
    try {
      await llmServer.stop();
      this.setIsRunning(false);
      this.setError(null);
    } catch (e: any) {
      console.error('Failed to stop LLM server:', e);
      this.setError(e.message || 'Failed to stop server');
    }
  };

  toggleServer = async () => {
    if (this.isRunning) {
      await this.stopServer();
    } else {
      await this.startServer();
    }
  };

  get serverUrl() {
    const host = this.exposeToLan ? this.ipAddress : '127.0.0.1';
    return `http://${host}:${this.port}`;
  }
}

export const localLlmServerStore = new LocalLlmServerStore();
