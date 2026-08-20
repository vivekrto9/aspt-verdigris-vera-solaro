export const jsonRequest = (path, body, init = {}) =>
  new Request(`http://127.0.0.1:4331${path}`, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const invalidJsonRequest = (path) =>
  new Request(`http://127.0.0.1:4331${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{invalid-json",
  });

export const readJson = async (response) => ({
  statusCode: response.status,
  body: await response.json(),
});

export const createFakeD1 = () => {
  const statements = [];

  return {
    statements,
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) {
          statement.values = values;
          return statement;
        },
        async run() {
          statements.push({ sql, values: statement.values });
          return { success: true };
        },
      };

      return statement;
    },
  };
};

export const createContext = ({ request, env = {}, db = createFakeD1() }) => ({
  request,
  locals: {
    runtime: {
      env: {
        DB: db,
        ...env,
      },
    },
  },
});

export const sampleBirthPayload = {
  displayName: "Test Visitor",
  email: "visitor@example.com",
  birthDate: "1990-01-01",
  birthTime: "10:30",
  birthPlace: "Delhi",
  latitude: 28.6139,
  longitude: 77.209,
  timezone: "5.5",
  language: "en",
};
