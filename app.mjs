import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import dir from 'node-dir';
import TurndownService from 'turndown';
import { create } from 'domain';
// static
const nodebbHost = "http://localhost:4567";
const nodebbHeaders = {
    Authorization : "Bearer b18bcbb2-c30f-432e-9747-a4ce85227808",
    "Content-Type": "application/json"
};

const turndownService = new TurndownService();

//lookups
// Tetra post id to nodebb post id
const tetraPid2nodePid = {};
// Tetra post id to nodebb topic id
const tetraPid2nodeTid = {};



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
    //https://community.nodebb.org/api/user/username/{username}

    const uid = await fetch(
        encodeURI(`${nodebbHost}/api/user/username/${username}?_uid=1`),
        {
            method :  'GET',
            headers: nodebbHeaders
        }
    ).then( res => {
        if (res.status == 200) {
            const resBody = await res.json();
            return resBody.uid;
        }
        return await createUser(username, email);
    });

    return uid;
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

    return resBody.response.uid;
}

async function parseTetraPost(data) {

    let isThreadStart = false;
    let previous = null;
    let next = null;
    // if this post is the beginning of a tetra-thread use the subject for a new nodebb-topic
    let subject = null;
    let timestamp = null;
    let uid = null;
    let email = null;
    let username = null;


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
                subject = value;                
                break;
            case "POSTER":
                username = value;
                break;
            case "EMAIL":
                // ignore email for now so we are not leaking anything accidentally
                // email = value
                email = "";
                break;
            case "DATE":
                timestamp = value;
                break;
            case "IP_ADDRESS":
                // ignore
                break;
            case "PASSWORD":
                // ignore
                break;
            case "PREVIOUS":
                // if there is no previous post it is the start of a topic
                isThreadStart = !value;
                previous = value;
                break;
            case "NEXT":
                next = value.trim().split(" ").filter(s => s.length > 0);
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
    let path = null;
    let responseAction = null;

    const contentHtml = data.substring(lineStart);

    console.log(`HTML raw:\n${contentHtml}`)

    // Make image urls absolute
    const contentAbs = contentHtml.replaceAll('"/webbbs/media', '"https://www.lepiforum.de/webbbs/media')

    const contentMd = turndownService.turndown(contentAbs);

    console.log(`Markdown post:\n${contentMd}`);

    let post = {
        content: contentMd,
        _uid: await getOrCreateUserId(username, email),
    }

    if (isThreadStart) {

        path = `${nodebbHost}/api/v3/topics/`
        post.title = subject;
        post.cid = 5; // TODO
        responseAction = (tetraPid, resBody) => {
            const tid  = resBody.response.tid;

            tetraPid2nodeTid[tetraPid] = tid;

            console.log(`Migrated Tetra post ${tetraPid} as Node topic ${tid}`);
        }
    } else {
        // post to an existing topic
        const tid = tetraPid2nodeTid[previous];
        if (!tid) {
            throw new Error(`Cannot find topic id for Tetra post ${previous}`)
        }
        path = `${nodebbHost}/api/v3/topics/${tid}`;

        const previousNodeBBPid = tetraPid2nodePid[previous];
        if (previousNodeBBPid) {
            // This post is a sub thread
            post.toPid = previousNodeBBPid;
        }

        // Prepend former title to the post content
        post.content = `${subject}\n${post.content}`;
        post.timestamp = timestamp;
        responseAction = (tetraPid, resBody) => {
            tetraPid2nodeTid[tetraPid] = tid;
            const pid = resBody.pid;
            tetraPid2nodePid[tetraPid] = pid;
            console.log(`Migrated Tetra post ${tetraPid} to Node topic ${tid} as post ${pid}`);
        }
    }


    return {
        path: path,
        body: post,
        next: next,
        responseAction: responseAction,
    }

}

//let file= '/home/thoni/Documents/projects/lepiforum/994-test-beitrag';
//const file = "/home/thoni/Documents/projects/lepiforum/forum_2_2013/bbs0/2";

async function migrateTetraPost(file) {
    const tetraPid = path.basename(file)
    console.log(`Processing ${tetraPid}`);
    let data = fs.readFileSync(file, 'latin1');
    
    let reqData = await parseTetraPost(data)

    if (!reqData) {
        return;
    }
    // console.log(reqData);

    const res = await fetch(
        reqData.path,
        {
            method: "POST",
            headers: nodebbHeaders,
            body: JSON.stringify(reqData.body),
        }
    )

    if (res.status != 200) {
        console.log(res);
        throw new Error(`Failed to migrate post ${file}`);
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

dir.files("/home/thoni/Documents/projects/lepiforum/test/", async function(err, files) {
    if (err) throw err;

    const done = [];


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

    const handleTetraPost = async function(f) {
        if (!/^[0-9]+$/.test(path.basename(f))) {
            return;
        }

        if (done.includes(f)) {
            return;
        }


        const next = await migrateTetraPost(f);
        
        done.push(f);

        // handle next post recusively

        if (!next || next.length == 0) {
            return;
        }

        console.log(next);

        for( const pid of next) {
            await handleTetraPost(findTetraPost(pid));
        }
                
    }
    
    for( const f of files) {
        handleTetraPost(f)
            .catch(err => errors.push(err))
            .finally(() => errors.forEach(err => console.log(err.message)));
    }
});

