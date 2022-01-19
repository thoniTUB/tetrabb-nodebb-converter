import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import dir from 'node-dir';
import TurndownService from 'turndown';
import XRegExp from 'xregexp';

// static
const nodebbHost = "http://localhost:4567";
const nodebbHeaders = {
    Authorization : "Bearer b18bcbb2-c30f-432e-9747-a4ce85227808",
    "Content-Type": "application/json"
};
const maxPostLength = 32000;

const turndownService = new TurndownService();

//lookups
// parsed tetra posts
const tetraPosts = {}
// Tetra post id to nodebb post id
const tetraPid2nodePid = {};
// Tetra post id to nodebb topic id
const tetraPid2nodeTid = {};
// users created in this run (mapping of username to promise with uid)
const users = {};
let topicCreatedCount = 0;
let postCreatedCount = 0;
let userCreatedCount = 0;


// TODO
async function createUserKeycloak(userRepresentation) {
    // https://www.keycloak.org/docs-api/15.0/rest-api/index.html#_users_resource
    const response = await fetch (
        "http://keycloak/auth/users",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(userRepresentation)
        }
    )


}

async function getOrCreateUserId(username, email) {

    // check if user mapping already exists
    let uid =  users[username];
    if (uid) {
        return uid;
    }

    // Check in nodebb if user exists
    //https://community.nodebb.org/api/user/username/{username}
    uid = fetch(
        encodeURI(`${nodebbHost}/api/user/username/${username}?_uid=1`),
        {
            method :  'GET',
            headers: nodebbHeaders
        }
    )
    .then(res => {
        if(res.ok) {
            // user was already created in nodebb
            return res.json().then(json => { return json.uid});
        }

        // User needs to be created
        return createUser(username, email)
    });

    users[username] = uid;

    return uid
}

async function createUser(username, email) {
    const reqBody =  {
        "username": username,
        "email": email
    
    };
    
    const response = await fetch(
            `${nodebbHost}/api/v3/users?_uid=1`,
            {
                method: 'POST',
                headers: {
                    Authorization : "Bearer b18bcbb2-c30f-432e-9747-a4ce85227808",
                    "Content-Type": "application/json"
                },
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
    if (isUserNameValid(username) && userslug){
        return username;
    }
    let sani = username.replace(/,/,'');
    sani = sani.replace(/&amp/,'+');
    sani = sani.replace(/ï¿½/,'ß');
    sani = sani.replace(/e/,'ě');
    sani = XRegExp.replace(sani, invalidUnicodeChars, '-');
    sani = sani.replace(/[^'" \-+.*[\]0-9\u00BF-\u1FFF\u2C00-\uD7FF\w]/,'')
    console.log(`Sanitized username: ${username} => ${sani} (${Buffer.from(username).toString('hex')} -> ${Buffer.from(sani).toString('hex')})`);
    return sani;
}

function getParsedTetraPost(tetraPostFileName) {

    const tetraPid = path.basename(tetraPostFileName)

    let post = tetraPosts[tetraPid]

    if (post) {
        // post was already parsed
        return post;
    }

    console.log(`Parsing ${tetraPid}`);
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
    let lineEnd = data.indexOf("\n");
    while(true) {
        let line = data.substring(lineStart, lineEnd);
        // console.log(line);
        let match = kvMatcher.exec(line);

        if (!match) {
            break;
        }

        let key = match.groups.key;
        let value = match.groups.value;
        // console.log(`Extracted Key: ${key}\tValue: ${value}`);
        // console.log('------');

        if (!key) {
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
        lineStart = lineEnd+1;
        lineEnd = data.indexOf("\n", lineStart);
    }

    // default is new thread

    const contentHtml = data.substring(lineStart);

    // Make image urls absolute
    const contentAbs = contentHtml.replaceAll('"/webbbs/', '"https://www.lepiforum.de/webbbs/')

    parsed.content = turndownService.turndown(contentAbs);
    return parsed;
}

async function preparePostForRequest(parsed){

    let path = null;
    let responseAction = null;

    let post = {
        content: parsed.content,
        _uid: await getOrCreateUserId(parsed.username, parsed.email),
    }

    if (parsed.isThreadStart) {

        path = `${nodebbHost}/api/v3/topics/`
        post.title = parsed.subject;
        post.cid = 5; // TODO
        post.timestamp = parsed.timestamp;

        if (post.content.length < 8) {
            post.content = post.content +"*Platzhalter: Originalpost hatte nur einen zu kurzen Inhalt*"
        }

        responseAction = (tetraPid, resBody) => {
            const tid  = resBody.response.tid;
            const pid  = resBody.response.mainPid;

            tetraPid2nodeTid[tetraPid] = tid;
            tetraPid2nodePid[tetraPid] = pid;

            topicCreatedCount++;
            console.log(`Migrated Tetra post ${tetraPid} as Node topic ${tid} with post ${pid}`);
        }
    } else {
        // post to an existing topic
        const tid = tetraPid2nodeTid[parsed.previous];
        if (!tid) {
            throw new Error(`Cannot find topic id for Tetra post ${parsed.previous}`)
        }
        path = `${nodebbHost}/api/v3/topics/${tid}`;

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
            console.log(`Migrated Tetra post ${tetraPid} to Node topic ${tid} as post ${pid}`);
        }
    }


    const {split , rest} = splitContent(post.content);

    if (rest) {
        // The tetra post is longer than than nodebb allows: split it and make more posts
        // The responseAction is just extended and migrates the rest as an response to the actual post.
        const prevAction = responseAction;
        responseAction = async function (tetraPid, resBody) {
            prevAction(tetraPid,resBody);

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
        return {split: content, rest: undefined};
    }

    splitEnd = content.slice(0, maxPostLength).lastIndexOf('\n');

    const split = content.slice(0,splitEnd);
    const rest = content.slice(splitEnd);

    return {split: split, rest: rest};
}

//let file= '/home/thoni/Documents/projects/lepiforum/994-test-beitrag';
//const file = "/home/thoni/Documents/projects/lepiforum/forum_2_2013/bbs0/2";

async function migrateTetraPost(tetraPid, parsed) {

    console.log(`Migrating tetra post ${tetraPid}`);
    
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
        console.log(reqData);
        console.log(res);
        throw new Error(`Failed to migrate post ${tetraPid}`);
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

dir.files("/home/thoni/Documents/projects/lepiforum/test2/", async function(err, files) {
    if (err) throw err;

    const findTetraPost = tetraPid => {
        const result = files.filter(f => path.basename(f) == tetraPid);

        if (result.length == 0) {
            throw new Error(`Unable to find tetra post ${tetraPid}`);
        }
        else if(result.length > 1) {
            throw new Error(`Tetra post id did not led to a distinct post. Found: ${result.toString()}`);
        }

        return result[0];
    }

    const handleTetraPost = async function(f, onlyThreadStart) {
        if (!/^[0-9]+$/.test(path.basename(f))) {
            return;
        }


        const tetraPid = path.basename(f);

        const parsed = getParsedTetraPost(f);


        if (!(parsed.isThreadStart == onlyThreadStart)) {
            // skip post for now because it is not the beginning of a topic
            return;
        }

        let next;

        try {

            next = await migrateTetraPost(tetraPid, parsed);
        } catch (err) {
            var newErr = new Error(`Failed to migrate post ${tetraPid}`);
            newErr.stack += `\nCaused by: ${err.message}\n${err.stack}`;
            throw newErr;
        }
        
        // handle next post recusively

        if (!next || next.length == 0) {
            return;
        }

        console.log(next);

        for( const pid of next) {
            try {
                await handleTetraPost(findTetraPost(pid), false)

            } catch(err) {
                errors.push(err);
            }
        }
                
    }
    
    for( const f of files) {
        await handleTetraPost(f, true)
            //.catch(err => errors.push(err))
            .finally(() => {
                errors.forEach(err => console.log(err.message))

                console.log(`Migrated ${((topicCreatedCount + postCreatedCount)/files.length*100).toFixed(2)}%: Topics: ${topicCreatedCount} | Posts: ${postCreatedCount} | TetraPosts: ${files.length} | ${userCreatedCount} Users`);
            });
    }
});

