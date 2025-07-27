-- Foreign Key Constraints Showcase Test
-- This script demonstrates pgterra's comprehensive FK support

-- Basic blog system with multiple FK relationships
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  username VARCHAR(50) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Self-referencing categories with CASCADE delete
CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  parent_id INTEGER,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) NOT NULL UNIQUE,
  CONSTRAINT fk_categories_parent 
    FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE CASCADE
);

-- Posts with FK to users and categories
CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  content TEXT,
  published BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  -- FK with CASCADE delete for user, RESTRICT for category
  CONSTRAINT fk_posts_user 
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_posts_category 
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Comments with nested structure
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  parent_comment_id INTEGER,
  content TEXT NOT NULL,
  approved BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT fk_comments_post 
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  CONSTRAINT fk_comments_user 
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_comments_parent 
    FOREIGN KEY (parent_comment_id) REFERENCES comments(id) ON DELETE CASCADE
);

-- Tags for posts
CREATE TABLE tags (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  color VARCHAR(7) DEFAULT '#000000'
);

-- Many-to-many relationship between posts and tags
CREATE TABLE post_tags (
  post_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (post_id, tag_id),
  
  CONSTRAINT fk_post_tags_post 
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  CONSTRAINT fk_post_tags_tag 
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

-- Composite FK example: Employee system
CREATE TABLE companies (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL
);

CREATE TABLE departments (
  company_id INTEGER NOT NULL,
  dept_id INTEGER NOT NULL,
  name VARCHAR(100) NOT NULL,
  budget DECIMAL(12,2),
  PRIMARY KEY (company_id, dept_id),
  
  CONSTRAINT fk_departments_company 
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE employees (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  dept_id INTEGER NOT NULL,
  manager_id INTEGER,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(100) NOT NULL,
  salary DECIMAL(10,2),
  hire_date DATE DEFAULT CURRENT_DATE,
  
  -- Composite FK to departments
  CONSTRAINT fk_employees_department 
    FOREIGN KEY (company_id, dept_id) 
    REFERENCES departments(company_id, dept_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  
  -- Self-referencing FK for manager
  CONSTRAINT fk_employees_manager 
    FOREIGN KEY (manager_id) REFERENCES employees(id) ON DELETE SET NULL
);

-- Order system with different referential actions
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL
);

CREATE TABLE order_statuses (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  is_final BOOLEAN DEFAULT false
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER,
  status_id INTEGER DEFAULT 1,
  total_amount DECIMAL(10,2) NOT NULL,
  order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  -- Different referential actions demonstrated
  CONSTRAINT fk_orders_customer 
    FOREIGN KEY (customer_id) 
    REFERENCES customers(id) ON DELETE SET NULL ON UPDATE CASCADE,
    
  CONSTRAINT fk_orders_status 
    FOREIGN KEY (status_id) 
    REFERENCES order_statuses(id) ON DELETE SET DEFAULT ON UPDATE RESTRICT
);

CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price DECIMAL(8,2) NOT NULL,
  
  CONSTRAINT fk_order_items_order 
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

-- Complex circular dependency example
CREATE TABLE teams (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  captain_id INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE players (
  id SERIAL PRIMARY KEY,
  team_id INTEGER,
  name VARCHAR(100) NOT NULL,
  position VARCHAR(50),
  jersey_number INTEGER,
  
  CONSTRAINT fk_players_team 
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL
);

-- Note: This constraint would need to be added separately due to circular dependency
-- ALTER TABLE teams ADD CONSTRAINT fk_teams_captain 
-- FOREIGN KEY (captain_id) REFERENCES players(id) ON DELETE SET NULL;