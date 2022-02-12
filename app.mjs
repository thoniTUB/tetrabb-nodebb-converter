import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import dir from 'node-dir';
import TurndownService from 'turndown';
import XRegExp from 'xregexp';
import winston from 'winston';
import nconf from 'nconf';

// script config
nconf
    .argv(
        {
            "token": {
                alias: 't',
                describe: 'A master token to access the nodebb api. Master tokens must be created with uid=0',
                demand: true,
                parseValues: true
            },
            "nodebb-url": {
                alias: 'u',
                describe: 'The base url of the nodebb forum to migrate to',
                demand: true,
                default: 'http://localhost:4567',
                parseValues: true
            },
            "tetra-folder": {
                alias: 'f',
                describe: 'The folder under which to search for tetra forum posts',
                demand: true,
                default: '.',
                parseValues: true
            }
        }
    )
    .required(['token', 'nodebb-url', 'tetra-folder']);
const token = nconf.get('token')
const nodebbUrl = nconf.get('nodebb-url')
const tetraFolder = nconf.get('tetra-folder')

// configure logging
const myFormat = winston.format.printf(({ level, message, timestamp }) => {
    return `${timestamp} ${level}: ${message}`;
});

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        myFormat
    ),
    defaultMeta: { service: 'user-service' },
    transports: [
        //
        // - Write all logs with importance level of `error` or less to `error.log`
        // - Write all logs with importance level of `info` or less to `combined.log`
        //
        new winston.transports.Console({ level: 'info' }),
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
    ],
});

// static
const nodebbHost = nodebbUrl;
const nodeApi = `${nodebbHost}/api/v3`
const nodebbHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
};
const maxPostLength = 32000;

const turndownService = new TurndownService();

// Lookups
// parsed tetra posts
const tetraPosts = {}
// Tetra post id to nodebb post id
let tetraPid2nodePid = {};
// Tetra post id to nodebb topic id
let tetraPid2nodeTid = {};
// users created in this run (mapping of username to promise with uid)
const users = {};

// Statistics
let topicCreatedCount = 0;
let postCreatedCount = 0;
let userCreatedCount = 0;
let postSkippedCount = 0;

async function getOrCreateUserId(username, email) {

    // check if user mapping already exists
    let uid = users[username];
    if (uid) {
        return uid;
    }

    // Check in nodebb if user exists
    //https://community.nodebb.org/api/user/username/{username}
    uid = fetch(
        encodeURI(`${nodebbHost}/api/user/username/${username}?_uid=1`),
        {
            method: 'GET',
            headers: nodebbHeaders
        }
    )
        .then(res => {
            if (res.ok) {
                // user was already created in nodebb
                return res.json().then(json => { return json.uid });
            }

            // User needs to be created
            return createUser(username, email)
        });

    users[username] = uid;

    return uid
}

async function createUser(username, email) {
    const reqBody = {
        "username": username,
        "email": email

    };

    const response = await fetch(
        `${nodeApi}/users?_uid=1`,
        {
            method: 'POST',
            headers: nodebbHeaders,
            body: JSON.stringify(reqBody)
        }
    );
    const resBody = await response.json();

    if (resBody.status.code != 'ok') {
        throw new Error(`Failed to create User (${username}): ${resBody.status.message}`)
    }

    userCreatedCount++;

    return resBody.response.uid;
}


// From nodebb:public/src/modules/slugify.js
const invalidUnicodeChars = XRegExp('[^\\p{L}\\s\\d\\-_]', 'g');
const invalidLatinChars = /[^\w\s\d\-_]/g;
const trimRegex = /^\s+|\s+$/g;
const collapseWhitespace = /\s+/g;
const collapseDash = /-+/g;
const trimTrailingDash = /-$/g;
const trimLeadingDash = /^-/g;
const isLatin = /^[\w\d\s.,\-@]+$/;

function slugify(str, preserveCase) {
    if (!str) {
        return '';
    }
    str = String(str).replace(trimRegex, '');
    if (isLatin.test(str)) {
        str = str.replace(invalidLatinChars, '-');
    } else {
        str = XRegExp.replace(str, invalidUnicodeChars, '-');
    }
    str = !preserveCase ? str.toLocaleLowerCase() : str;
    str = str.replace(collapseWhitespace, '-');
    str = str.replace(collapseDash, '-');
    str = str.replace(trimTrailingDash, '');
    str = str.replace(trimLeadingDash, '');
    return str;
};
function isUserNameValid(name) {
    return (name && name !== '' && (/^['" \-+.*[\]0-9\u00BF-\u1FFF\u2C00-\uD7FF\w]+$/.test(name)));
}

function sanitizeUsername(username) {
    let userslug = slugify(username)
    if (isUserNameValid(username) && userslug) {
        return username;
    }
    let sani = username.replace(/,/, '');
    sani = sani.replace(/&amp/, '+');
    sani = XRegExp.replace(sani, invalidUnicodeChars, '-');
    sani = sani.replace(/[^'" \-+.*[\]0-9\u00BF-\u1FFF\u2C00-\uD7FF\w]/, '')
    logger.debug(`Sanitized username: ${username} => ${sani} (${Buffer.from(username).toString('hex')} -> ${Buffer.from(sani).toString('hex')})`);
    return sani;
}

function getParsedTetraPost(tetraPostFileName) {

    const tetraPid = path.basename(tetraPostFileName)

    let post = tetraPosts[tetraPid]

    if (post) {
        // post was already parsed
        return post;
    }

    logger.debug(`Parsing ${tetraPid}`);
    let tetraPostRaw = fs.readFileSync(tetraPostFileName, 'latin1');

    post = parseTetraPost(tetraPostRaw);

    tetraPosts[tetraPid] = post;

    return post;

}

function parseTetraPost(data) {

    let parsed = {
        isThreadStart: false,
        previous: null,
        next: null,
        // if this post is the beginning of a tetra-thread use the subject for a new nodebb-topic
        subject: null,
        timestamp: null,
        email: null,
        username: null,
        content: null,
    };


    const kvMatcher = /^(?<key>[A-Z_]+)\>(?<value>.*)/;

    let lineStart = 0;
    let lineEnd = -1;
    while (true) {
        lineStart = lineEnd + 1;
        lineEnd = data.indexOf("\n", lineStart);
        let line = data.substring(lineStart, lineEnd);
        logger.debug(line);

        if (line.startsWith('<!--')) {
            // some posts contain comments that are not relevant
            continue;
        }

        let match = kvMatcher.exec(line);

        if (!match) {
            break;
        }

        let key = match.groups.key;
        let value = match.groups.value;
        logger.debug(`Extracted Key: ${key}\tValue: ${value}`);

        if (!key || key.startsWith('<!--')) {
            break;
        }
        switch (key) {
            case "SUBJECT":
                parsed.subject = value;
                break;
            case "POSTER":
                parsed.username = sanitizeUsername(value);
                break;
            case "EMAIL":
                // ignore email for now so we are not leaking anything accidentally
                // email = value
                parsed.email = "";
                break;
            case "DATE":
                // left-pad to nodebb: format millis since epoche
                parsed.timestamp = value.padEnd(13, '0');
                break;
            case "IP_ADDRESS":
                // ignore
                break;
            case "PASSWORD":
                // ignore
                break;
            case "PREVIOUS":
                // if there is no previous post it is the start of a topic
                parsed.isThreadStart = !value;
                parsed.previous = value.trim();
                break;
            case "NEXT":
                parsed.next = value.trim().split(" ").filter(s => s.length > 0);
                break;
            case "IMAGE":
                // ignore
                break;
            case "LINKNAME":
                // ignore
                break;
            case "LINKURL":
                // ignore
                break;
            default:
                break;
        }
    }

    // default is new thread

    const contentHtml = data.substring(lineStart);

    // Make image urls absolute
    const contentAbs = contentHtml.replaceAll('"/webbbs/', '"https://www.lepiforum.de/webbbs/')

    parsed.content = turndownService.turndown(contentAbs);
    return parsed;
}

async function preparePostForRequest(parsed) {

    let path = null;
    let responseAction = null;

    let post = {
        content: parsed.content,
        _uid: await getOrCreateUserId(parsed.username, parsed.email),
    }

    if (parsed.isThreadStart) {
        // create a new topic

        path = `${nodeApi}/topics/`
        post.title = parsed.subject;
        post.cid = 5; // TODO
        post.timestamp = parsed.timestamp;

        if (post.content.length < 8) {
            post.content = post.content + "*Platzhalter: Originalpost hatte nur einen zu kurzen Inhalt*"
        }

        responseAction = (tetraPid, resBody) => {
            const tid = resBody.response.tid;
            const pid = resBody.response.mainPid;

            tetraPid2nodeTid[tetraPid] = tid;
            tetraPid2nodePid[tetraPid] = pid;

            topicCreatedCount++;
            logger.debug(`Migrated Tetra post ${tetraPid} as Node topic ${tid} with post ${pid}`);
        }
    } else {
        // post to an existing topic
        const tid = tetraPid2nodeTid[parsed.previous];
        if (!tid) {
            throw new Error(`Cannot find topic id for Tetra post ${parsed.previous}`)
        }
        path = `${nodeApi}/topics/${tid}`;

        const previousNodeBBPid = tetraPid2nodePid[parsed.previous];
        if (previousNodeBBPid) {
            // This post is a sub thread
            post.toPid = previousNodeBBPid;
        }

        // Prepend former title to the post content
        post.content = `${parsed.subject ? parsed.subject + "\n" : ""}${post.content}`;
        post.timestamp = parsed.timestamp;
        responseAction = (tetraPid, resBody) => {
            const tid = resBody.response.tid;
            tetraPid2nodeTid[tetraPid] = tid;
            const pid = resBody.response.pid;
            tetraPid2nodePid[tetraPid] = pid;

            postCreatedCount++;
            logger.debug(`Migrated Tetra post ${tetraPid} to Node topic ${tid} as post ${pid}`);
        }
    }


    const { split, rest } = splitContent(post.content);

    if (rest) {
        // The tetra post is longer than than nodebb allows: split it and make more posts
        // The responseAction is just extended and migrates the rest as an response to the actual post.
        const prevAction = responseAction;
        responseAction = async function (tetraPid, resBody) {
            prevAction(tetraPid, resBody);

            // TODO use structured clone from node 17
            const ext = JSON.parse(JSON.stringify(parsed));
            ext.isThreadStart = false;
            ext.previous = tetraPid;
            ext.content = rest;
            ext.subject = undefined;
            ext.next = undefined;

            return await migrateTetraPost(tetraPid, ext);
        }

    }

    post.content = split;

    return {
        path: path,
        body: post,
        next: parsed.next,
        responseAction: responseAction,
    }
}

function splitContent(content) {
    const splits = [];
    const length = content.length;
    let splitEnd = 0;

    if (length <= maxPostLength) {
        return { split: content, rest: undefined };
    }

    splitEnd = content.slice(0, maxPostLength).lastIndexOf('\n');

    const split = content.slice(0, splitEnd);
    const rest = content.slice(splitEnd);

    return { split: split, rest: rest };
}

//let file= '/home/thoni/Documents/projects/lepiforum/994-test-beitrag';
//const file = "/home/thoni/Documents/projects/lepiforum/forum_2_2013/bbs0/2";

async function migrateTetraPost(tetraPid, parsed) {

    logger.debug(`Migrating tetra post ${tetraPid}`);

    const reqData = await preparePostForRequest(parsed);

    const res = await fetch(
        reqData.path,
        {
            method: "POST",
            headers: nodebbHeaders,
            body: JSON.stringify(reqData.body),
        }
    )

    if (res.status != 200) {
        logger.error({ "Request": reqData, "Response": res });
        throw new Error(`Failed to migrate post ${tetraPid}. Please also check the server logs. Request: ${JSON.stringify(reqData)}, Response: ${JSON.stringify(res)}`);
    }
    const resBody = await res.json();

    if (resBody.status.code != 'ok') {
        throw new Error(resBody.status.message);
    }

    // register migrated post
    reqData.responseAction(tetraPid, resBody);
    return reqData.next;
}

let errors = [];

async function alterAdminSettings(settings) {

    for (const [setting, value] of Object.entries(settings)) {
        const res = await fetch(
            `${nodeApi}/admin/settings/${setting}?_uid=1`,
            {
                method: "PUT",
                headers: nodebbHeaders,
                body: JSON.stringify({ value: value }),
            }
        )

        if (res.status != 200) {
            logger.error(`Unable to set admin setting: ${setting}:${value}`);
            throw new Error(`Unable to set admin setting: ${setting}:${value}. Please look into the server logs.`)
        }
    }

}

logger.info(`Preparing admin settings to allow imidiate posts.`)
await alterAdminSettings({
    postDelay: 0,
    newbiePostDelayThreshold: 0,
    newbiePostDelay: 0,
    initialPostDelay: 0,
    newbiePostEditDuration: 0
});

const mapping_file = "migration_map.json"
logger.info(`Checking for previous post mappings in file: ${mapping_file}`)

if (fs.existsSync(mapping_file)) {
    try {
        const data = fs.readFileSync(mapping_file, { encoding: 'utf8', flag: 'r' });

        // parse JSON object
        ({ tetraPid2nodePid, tetraPid2nodeTid } = JSON.parse(data.toString()));


        logger.info(`Loaded mappings for ${tetraPid2nodePid.length} posts`)
    } catch (err) {
        throw err;
    }

}

dir.files(tetraFolder, async function (err, files) {
    if (err) throw err;

    // filter out all files whose file name is not a plain number
    let postFiles = files.filter(f => /^[0-9]+$/.test(path.basename(f)))

    const findTetraPost = tetraPid => {
        const result = postFiles.filter(f => path.basename(f) == tetraPid);

        if (result.length == 0) {
            throw new Error(`Unable to find tetra post ${tetraPid}`);
        }
        else if (result.length > 1) {
            throw new Error(`Tetra post id did not led to a distinct post. Found: ${result.toString()}`);
        }

        return result[0];
    }

    const digits = postFiles.length.toString().length;
    const padFileRelNumber = number => {
        return number.toString().padStart(digits)
    }


    const handleTetraPost = async function (f) {

        const tetraPid = path.basename(f);

        // Check first if post was already migrated
        if (tetraPid in tetraPid2nodePid) {
            postSkippedCount++;
            logger.debug(`Skipping Tetra post ${tetraPid}. Was already migrated`)
            return;
        }

        const parsed = getParsedTetraPost(f);


        if (!(parsed.isThreadStart || parsed.previous in tetraPid2nodePid)) {
            // skip post for now because it is not the beginning of a topic or it's precessor was not migrated yet
            return;
        }

        let next;

        try {

            next = await migrateTetraPost(tetraPid, parsed);
        } catch (err) {
            var newErr = new Error(`Failed to migrate post ${tetraPid}`);
            newErr.stack += `\nCaused by: ${err.stack}`;
            throw newErr;
        }

        // handle next post recusively

        if (!next || next.length == 0) {
            return;
        }

        for (const pid of next) {
            try {
                await handleTetraPost(findTetraPost(pid))

            } catch (err) {
                errors.push(err);
            }
        }

    }

    // main loop
    for (const f of postFiles) {
        await handleTetraPost(f, true)
            //.catch(err => errors.push(err))
            .finally(() => {

                logger.info(`Migrated ${((topicCreatedCount + postCreatedCount + postSkippedCount) / (postFiles.length) * 100).toFixed(2).padStart(6)}%: NodeBBTopics: ${padFileRelNumber(topicCreatedCount)} | NodeBBPosts: ${padFileRelNumber(postCreatedCount)} | Skipped: ${padFileRelNumber(postSkippedCount)} | TetraPosts: ${postFiles.length} | ${userCreatedCount} Users`);
            });
    }
    errors.forEach(err => logger.error(err.message))

    try {
        fs.writeFileSync(mapping_file, JSON.stringify({ tetraPid2nodePid, tetraPid2nodeTid }));
        logger.info(`Saved post mapping to ${mapping_file}`);
    } catch (error) {
        logger.error(error);
        throw error;
    }

    logger.info(`Resetting admin settings to to normal operation.`)
    await alterAdminSettings({
        postDelay: 10,
        newbiePostDelayThreshold: 3,
        newbiePostDelay: 120,
        initialPostDelay: 10,
        newbiePostEditDuration: 3600
    });
});


