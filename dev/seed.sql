-- Sample schema for local development and tests.

CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');

CREATE TABLE organizations (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  plan        text NOT NULL DEFAULT 'free',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id          bigserial PRIMARY KEY,
  org_id      integer NOT NULL REFERENCES organizations(id),
  email       text NOT NULL UNIQUE,
  full_name   text,
  is_admin    boolean NOT NULL DEFAULT false,
  settings    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz
);

CREATE TABLE products (
  id          serial PRIMARY KEY,
  sku         text NOT NULL UNIQUE,
  title       text NOT NULL,
  price       numeric(10, 2) NOT NULL,
  tags        text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE orders (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id),
  status      order_status NOT NULL DEFAULT 'pending',
  total       numeric(12, 2) NOT NULL DEFAULT 0,
  placed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  order_id    bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  integer NOT NULL REFERENCES products(id),
  quantity    integer NOT NULL CHECK (quantity > 0),
  unit_price  numeric(10, 2) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE VIEW revenue_by_org AS
  SELECT o.id AS org_id, o.name, sum(ord.total) AS revenue, count(ord.id) AS orders
  FROM organizations o
  JOIN users u ON u.org_id = o.id
  JOIN orders ord ON ord.user_id = u.id AND ord.status IN ('paid', 'shipped')
  GROUP BY o.id, o.name;

CREATE SCHEMA analytics;

CREATE TABLE analytics.events (
  id          bigserial PRIMARY KEY,
  user_id     bigint REFERENCES users(id),
  name        text NOT NULL,
  properties  jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO organizations (name, plan, created_at)
SELECT 'Org ' || g, (ARRAY['free', 'team', 'enterprise'])[1 + g % 3], now() - (g || ' days')::interval
FROM generate_series(1, 25) g;

INSERT INTO users (org_id, email, full_name, is_admin, settings, created_at, last_seen)
SELECT 1 + g % 25, 'user' || g || '@example.com', 'User ' || g, g % 17 = 0,
       jsonb_build_object('theme', CASE WHEN g % 2 = 0 THEN 'dark' ELSE 'light' END, 'beta', g % 5 = 0),
       now() - (g || ' hours')::interval,
       CASE WHEN g % 4 = 0 THEN NULL ELSE now() - (g || ' minutes')::interval END
FROM generate_series(1, 2000) g;

INSERT INTO products (sku, title, price, tags)
SELECT 'SKU-' || lpad(g::text, 4, '0'), 'Product ' || g, round((5 + random() * 200)::numeric, 2),
       ARRAY[(ARRAY['new', 'sale', 'popular', 'limited'])[1 + g % 4]]
FROM generate_series(1, 120) g;

INSERT INTO orders (user_id, status, placed_at)
SELECT 1 + (g * 7) % 2000, (ARRAY['pending', 'paid', 'shipped', 'cancelled']::order_status[])[1 + g % 4],
       now() - (g || ' minutes')::interval
FROM generate_series(1, 5000) g;

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT o.id, 1 + (o.id * k) % 120, 1 + (o.id + k) % 3, p.price
FROM orders o
CROSS JOIN generate_series(1, 3) k
JOIN products p ON p.id = 1 + (o.id * k) % 120
ON CONFLICT DO NOTHING;

UPDATE orders o SET total = s.sum
FROM (SELECT order_id, sum(quantity * unit_price) AS sum FROM order_items GROUP BY order_id) s
WHERE s.order_id = o.id;

INSERT INTO analytics.events (user_id, name, properties, occurred_at)
SELECT 1 + g % 2000, (ARRAY['page_view', 'signup', 'checkout', 'search'])[1 + g % 4],
       jsonb_build_object('path', '/p/' || g % 50), now() - (g || ' seconds')::interval
FROM generate_series(1, 20000) g;

ANALYZE;

CREATE DATABASE scratch;
