import { welcome, env, app, db } from "./config";
import { Request, Response } from "express";
import { getCookie } from "./config/http";
import { TwitterApi } from "twitter-api-v2";
import { encrypt } from "./crypto";
import start from "./cron";
import {
  APP_KEY,
  APP_SECRET,
  OAUTH_COOKIE,
  PROTOCOL,
  Subscription,
  User,
  UserCookie,
  USER_COOKIE,
} from "./types";
import Arweave from "arweave";

const arweave = Arweave.init({
  host: "arweave.net",
  port: 443,
  protocol: "https",
});

interface RequestWithSession extends Request {
  session: any;
}

const client = new TwitterApi({
  appKey: APP_KEY,
  appSecret: APP_SECRET,
});
welcome();

app.get("/", async (req: Request, res: Response) => {
  res.send("");
});

// OAuth Step 1
app.post(
  "/twitter/oauth/request_token",
  async (req: RequestWithSession, res: Response, next) => {
    try {
      const { url, oauth_token, oauth_token_secret, oauth_callback_confirmed } =
        await client.generateAuthLink(process.env.FRONTEND_URL);

      if (oauth_callback_confirmed !== "true") {
        res.status(500).json({});
      }

      req.session.oauth_token_secret = oauth_token_secret;
      req.session.save(function (err: any) {
        if (err) next(err);
      });

      res.cookie(OAUTH_COOKIE, oauth_token, {
        maxAge: 15 * 60 * 1000, // 15 minutes
        // secure: true,
        httpOnly: true,
        // sameSite: true,
        signed: true,
      });

      res.json({ oauth_token, url });
    } catch (e) {
      console.error(e);
      res.status(500).json({});
    }
  }
);

// OAuth Step 3
app.post(
  "/twitter/oauth/access_token",
  async (req: RequestWithSession, res: Response) => {
    try {
      // Extract tokens from query string
      const { oauth_token, oauth_verifier } = req.query;
      // Get the saved oauth_token_secret from session
      const { oauth_token_secret } = req.session;
      if (!oauth_token || !oauth_verifier || !oauth_token_secret) {
        return res
          .status(400)
          .send("You denied the app or your session expired!");
      }
      // Obtain the persistent tokens
      // Create a client from temporary tokens
      const client = new TwitterApi({
        appKey: APP_KEY,
        appSecret: APP_SECRET,
        accessToken: oauth_token as string,
        accessSecret: oauth_token_secret as string,
      });

      let {
        client: loggedClient,
        accessToken,
        accessSecret,
      } = await client.login(oauth_verifier as string);
      // loggedClient is an authenticated client in behalf of some user
      // Store accessToken & accessSecret somewhere

      let twitterUserData = await loggedClient.currentUser();

      let user: User;

      let dbUser = await db.fetchUserInfoByTwitterID(twitterUserData.id_str);
      let encAccessToken = encrypt(accessToken);
      let encTokenSecret = encrypt(accessSecret);

      if (dbUser.length === 0) {
        let res = await db.createNewUser({
          twitter_id: twitterUserData.id_str,
          twitter_handle: twitterUserData.screen_name,
          photo_url: twitterUserData.profile_image_url_https,
          oauth_access_token: encAccessToken.content,
          oauth_access_token_iv: encAccessToken.iv,
          oauth_secret_token: encTokenSecret.content,
          oauth_secret_token_iv: encTokenSecret.iv,
        });
        if (res.length === 0) {
          res.status(500).json({ error: "something went wrong" });
        }
        user = res[0];
      } else {
        user = dbUser[0];
        user.oauth_access_token = encAccessToken.content;
        user.oauth_access_token_iv = encAccessToken.iv;
        user.oauth_secret_token = encTokenSecret.content;
        user.oauth_secret_token_iv = encTokenSecret.iv;
        await db.updateUserInfo(user);
      }
      res.cookie(
        USER_COOKIE,
        {
          twitter_id: user.twitter_id,
          twitter_handle: user.twitter_handle,
          photo_url: user.photo_url,
          logged_in_method: "twitter",
        } as UserCookie,
        {
          maxAge: 8 * 60 * 60 * 1000, // 8 hours
          // secure: true,
          httpOnly: true,
          // sameSite: true,
          signed: true,
        }
      );
      res.status(200).json({
        twitter_id: user.twitter_id,
        twitter_handle: user.twitter_handle,
        photo_url: user.photo_url,
        expiry: Date.now() + 8 * 60 * 60 * 1000,
      });
    } catch (e: any) {
      console.error(e);
      res.status(403).send("Invalid verifier or access tokens!");
    }
  }
);

//Authenticated resource access
app.get("/twitter/users/me", async (req, res) => {
  try {
    const userCookie = getCookie(req, USER_COOKIE);

    let userInfo = await db.fetchUserInfoByTwitterID(userCookie.twitter_id);
    if (userInfo.length === 0) {
      res.status(500).json({ error: "internal error" });
      return;
    }

    let user = userInfo[0];
    res.status(200).json({
      twitter_id: user.twitter_id,
      twitter_handle: user.twitter_handle,
      is_subscribed: user.is_subscribed,
      photo_url: user.photo_url,
    });
  } catch (error) {
    console.error(error);
    res.status(403).json({ message: "Missing, invalid, or expired tokens" });
  }
});

app.post("/twitter/subscribe", async (req, res) => {
  try {
    let data = req.body;
    const user = getCookie(req, USER_COOKIE);

    // first check if we are already subscribed
    let sub = await db.subscription(user.twitter_id, data.address, PROTOCOL);
    if (sub.length > 0) {
      res
        .status(200)
        .json({ subscribed: true, address: data.address, protocol: PROTOCOL });
      return;
    }

    const blockHeight = (await arweave.blocks.getCurrent()).height;

    await db.subscribe(
      user.twitter_id,
      data.address,
      PROTOCOL,
      blockHeight.toString()
    );

    res
      .status(200)
      .json({ subscribed: true, address: data.address, protocol: PROTOCOL });
  } catch (error) {
    console.error(error);
    res.status(403).json({ message: "Missing, invalid, or expired tokens" });
  }
});

app.post("/twitter/unsubscribe", async (req, res) => {
  try {
    const user = getCookie(req, USER_COOKIE);
    let data = req.body;

    let sub = await db.subscription(user.twitter_id, data.address, PROTOCOL);

    if (sub.length === 0) {
      res.status(400).json({ error: "sub not found" });
      return;
    }

    await db.unsubscribe(user.twitter_id, data.address, PROTOCOL);

    res.json({ subscribed: false, address: data.address, protocol: PROTOCOL });
    return;
  } catch (error) {
    console.error(error);
    res.status(403).json({ message: "Missing, invalid, or expired tokens" });
  }
});

app.get("/subscriptions", async (req, res) => {
  try {
    const user = getCookie(req, USER_COOKIE);
    let result = await db.subscriptionsByUserID(user.twitter_id);

    res.status(200).send({ subscriptions: result as Subscription[] });
    return;
  } catch (e) {
    res.status(404).json({ message: "Problem fetching subscriptions" });
  }
});

// exit actually removes the twitter connection and logs out the user
app.post("/twitter/exit", async (req, res) => {
  try {
    const user = getCookie(req, USER_COOKIE);

    await db.removeTwitterAccess(user.twitter_id);

    res.json({ success: true });
  } catch (error) {
    res.status(403).json({ message: "Missing, invalid, or expired tokens" });
  }
});

// logout simply logs you out of the app, keeps the twitter connection
app.post("/logout", async (req, res) => {
  try {
    const user = getCookie(req, USER_COOKIE);

    res.cookie(OAUTH_COOKIE, {}, { maxAge: -1 });
    res.cookie(USER_COOKIE, {}, { maxAge: -1 });
    res.json({ success: true });
  } catch (error) {
    res.status(403).json({ message: "Missing, invalid, or expired tokens" });
  }
});

// we start the cron job
start();

// we listen to incoming requests
app.listen(env.PORT, () => {
  console.log(`⚡️[server]: Listening on http://localhost:${env.PORT}`);
});
