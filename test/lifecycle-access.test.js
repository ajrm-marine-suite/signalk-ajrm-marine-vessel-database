const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const packageInfo = require("../package.json");
const createPlugin = require("../plugin");

test("restart owns one delta listener and stop clears the retained summary", async () => {
  const app = createFakeApp();
  const plugin = createPlugin(app);
  const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "vessel-database-life-"));

  plugin.start({ databaseDirectory, publishSummary: true });
  plugin.start({ databaseDirectory, publishSummary: true });
  assert.equal(app.signalk.listenerCount("delta"), 1);

  await plugin.stop();
  assert.equal(app.signalk.listenerCount("delta"), 0);
  assert.equal(lastSummaryValue(app.messages), null);
});

test("mutation routes reject an explicitly unauthenticated request", () => {
  const app = createFakeApp();
  const plugin = createPlugin(app);
  const routes = registerRoutes(plugin);
  const response = createResponse();

  routes.get("POST /delete-all")({ skIsAuthenticated: false }, response);

  assert.equal(response.statusCode, 403);
  assert.match(response.body.error, /read\/write or admin/i);
});

test("OpenAPI documents every registered route and the supported Node baseline", () => {
  const plugin = createPlugin(createFakeApp());
  const routes = registerRoutes(plugin);
  const documented = new Set();
  for (const [routePath, operations] of Object.entries(plugin.getOpenApi().paths)) {
    for (const method of Object.keys(operations)) {
      documented.add(`${method.toUpperCase()} ${routePath.replace(/\{([^}]+)\}/g, ":$1")}`);
    }
  }

  assert.deepEqual(new Set(routes.keys()), documented);
  assert.equal(packageInfo.engines.node, ">=20");
});

function registerRoutes(plugin) {
  const routes = new Map();
  const router = {};
  for (const method of ["get", "post", "delete"]) {
    router[method] = (routePath, handler) => {
      routes.set(`${method.toUpperCase()} ${routePath}`, handler);
    };
  }
  plugin.registerWithRouter(router);
  return routes;
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

function lastSummaryValue(messages) {
  const values = messages.flatMap((message) =>
    (message.updates || []).flatMap((update) => update.values || []),
  );
  return values.filter((entry) => entry.path === "plugins.ajrmMarineVesselDatabase.summary").at(-1)
    ?.value;
}

function createFakeApp() {
  return {
    signalk: new EventEmitter(),
    messages: [],
    handleMessage(_id, message) {
      this.messages.push(message);
    },
    setPluginStatus() {},
    debug() {},
    error(error) {
      throw new Error(String(error));
    },
  };
}
