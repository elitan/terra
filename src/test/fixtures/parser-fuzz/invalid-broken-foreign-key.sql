CREATE TABLE child (
  id INT PRIMARY KEY,
  parent_id INT,
  CONSTRAINT fk_parent FOREIGN KEY (parent_id)
    REFERENCES parent(
);
