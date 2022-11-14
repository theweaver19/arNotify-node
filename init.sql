CREATE TABLE users(
    twitter_id INT NOT NULL PRIMARY KEY,
    twitter_handle TEXT NOT NULL UNIQUE,
    photo_url TEXT,
    oauth_access_token TEXT,
    oauth_access_token_iv TEXT,
    oauth_secret_token TEXT,
    oauth_secret_token_iv TEXT
);

CREATE TABLE protocols(
    protocol_name VARCHAR(255) NOT NULL PRIMARY KEY
);


CREATE TABLE tweets(
    tweet_id INT NOT NULL PRIMARY KEY,
    twitter_id INT,
    arweave_tx_id TEXT NOT NULL,
    protocol_name VARCHAR(255) NOT NULL,
    FOREIGN KEY (twitter_id) REFERENCES users(twitter_id),
    FOREIGN KEY (protocol_name) REFERENCES protocols(protocol_name)
);


CREATE TABLE subscriptions(
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, 
    twitter_id INT NOT NULL,
    arweave_address TEXT NOT NULL,
    protocol_name VARCHAR(255) NOT NULL,
    is_active BOOLEAN,    
    FOREIGN KEY (twitter_id) REFERENCES users(twitter_id),
    FOREIGN KEY (protocol_name) REFERENCES protocols(protocol_name)
);

INSERT INTO protocols (protocol_name) VALUES ("argora");