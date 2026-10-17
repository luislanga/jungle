process.env.NODE_ENV = 'test';
process.env.TZ = 'UTC';
process.env.PORT = '0';

// Individual HTTP/schema suites own their worker instances; composition tests enable real loops.
process.env.WORKERS_ENABLED = 'false';
