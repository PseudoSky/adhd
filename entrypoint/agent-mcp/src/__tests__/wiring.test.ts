import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import { runMigrationsOn } from '../db/migrate-runner.js';
import { config, loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { AgentStore } from '../store/agent-store.js';
import { SessionStore, TaskStore } from '@adhd/agent-store-runtime';
import { HookRegistry } from '@adhd/agent-engine-orchestrator';

describe('agent-mcp entrypoint wiring', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite, { schema });

    beforeAll(() => {
        runMigrationsOn(sqlite, db);
    });

    afterAll(() => {
        sqlite.close();
    });

    it('config loads and satisfies EngineConfig', () => {
        const env = {
            ADHD_AGENT_DATABASE_PATH: ':memory:',
            ADHD_AGENT_LOG_LEVEL: 'silent',
        };
        const cfg = loadConfig(env as NodeJS.ProcessEnv);
        expect(cfg.server.contextLimit).toBeDefined();
        expect(typeof cfg.isEnvNameAllowed).toBe('function');
        expect(typeof cfg.getProviderConfig).toBe('function');
        expect(typeof cfg.subprocessEnv).toBe('function');
    });

    it('logger creates a pino instance', () => {
        expect(logger).toBeDefined();
        expect(typeof logger.info).toBe('function');
        expect(typeof logger.error).toBe('function');
    });

    it('AgentStore can create, read, and delete an agent', () => {
        const hooks = new HookRegistry();
        const agentStore = new AgentStore(db as any, hooks);

        const agent = agentStore.create({
            name: 'test-agent',
            systemPrompt: 'You are a test agent.',
            provider: {
                type: 'openai',
                model: 'gpt-4',
            },
            mcpServers: {},
            permissions: {},
        });

        expect(agent.name).toBe('test-agent');
        expect(agent.version).toBe(1);

        const read = agentStore.read('test-agent');
        expect(read.name).toBe('test-agent');

        const list = agentStore.list();
        expect(list.length).toBe(1);

        agentStore.create({
            name: 'agent-2',
            systemPrompt: 'Another agent.',
            provider: {
                type: 'anthropic',
                model: 'claude-3-5-sonnet',
            },
            mcpServers: {},
            permissions: {},
        });

        const list2 = agentStore.list();
        expect(list2.length).toBe(2);

        agentStore.delete('agent-2');
        const list3 = agentStore.list();
        expect(list3.length).toBe(1);
    });

    it('SessionStore can create, read, and close a session', () => {
        const hooks = new HookRegistry();
        const agentStore = new AgentStore(db as any, hooks);
        const sessionStore = new SessionStore(db as any, hooks);

        const agentDef = agentStore.read('test-agent');

        const session = sessionStore.create({
            agentName: 'test-agent',
            agentDefinition: agentDef,
        });

        expect(session.id).toBeDefined();
        expect(session.agentName).toBe('test-agent');
        expect(session.status).toBe('active');

        const read = sessionStore.read(session.id);
        expect(read.id).toBe(session.id);

        sessionStore.close(session.id);
        const closed = sessionStore.read(session.id);
        expect(closed.status).toBe('closed');
    });

    it('TaskStore can create and read a task', () => {
        const taskStore = new TaskStore(db as any);

        const task = taskStore.create({
            sessionId: null,
            prompt: 'Hello, world!',
            isEphemeral: true,
        });

        expect(task.id).toBeDefined();
        expect(task.status).toBe('pending');
        expect(task.prompt).toBe('Hello, world!');

        const read = taskStore.read(task.id);
        expect(read.id).toBe(task.id);

        const list = taskStore.list({});
        expect(list.length).toBeGreaterThanOrEqual(1);
    });
});
