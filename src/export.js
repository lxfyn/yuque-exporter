import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { type } from './const.js';

// Statistics for write operations
const writeStats = {
    filesWritten: 0,
    filesSkippedUnchanged: 0,
    filesErrored: 0
};

// Get write strategy from environment variable
const WRITE_STRATEGY = (() => {
    const strategy = process.env.EXPORT_WRITE_STRATEGY || 'skip-unchanged';
    if (strategy !== 'skip-unchanged' && strategy !== 'overwrite') {
        console.warn(`Invalid EXPORT_WRITE_STRATEGY "${strategy}", falling back to "skip-unchanged"`);
        return 'skip-unchanged';
    }
    return strategy;
})();

export async function exportMarkDownFiles(page, books) {
    const folderPath = process.env.EXPORT_PATH;
    console.log("download folderPath: " + folderPath)
    console.log(`Write strategy: ${WRITE_STRATEGY}`);
    if (!fs.existsSync(folderPath)) {
        console.error(`export path:${folderPath} is not exist`)
        process.exit(1)
    }

    // console.log(books)
    for ( let i = 0; i < books.length; i++ ) {
        await exportMarkDownFileTree(page, folderPath, books[i], books[i].root)
        console.log();
    }

    console.log(`=====> Export successfully! Have a good day!`);
    console.log(`Summary: ${writeStats.filesWritten} written, ${writeStats.filesSkippedUnchanged} skipped (unchanged), ${writeStats.filesErrored} errors`);
    console.log();
}


async function exportMarkDownFileTree(page, folderPath, book, node) {
    switch (node.type) {
        case type.Book: 
            folderPath = path.join(folderPath, book.name);
            if (!fs.existsSync(folderPath)) {
                fs.mkdirSync(folderPath)
            }
            break;
        case type.Title: 
            folderPath = path.join(folderPath, node.name);
            if (!fs.existsSync(folderPath)) {
                fs.mkdirSync(folderPath)
            }
            break;
        case type.TitleDoc: 
            folderPath = path.join(folderPath, node.name);
            if (!fs.existsSync(folderPath)) {
                fs.mkdirSync(folderPath)
            }
        case type.Document: 
            const client = await page.target().createCDPSession()
            await client.send('Page.setDownloadBehavior', {
                behavior: 'allow',
                downloadPath: folderPath,
            })
            await downloadMardown(page, folderPath, book.name, node.name.replace(/\//g, '_'),
                book.user_url + "/" + book.slug + "/" + node.object.url)
            break;
    }

    if (node.children) {
        for (const childNode of node.children) {
            await exportMarkDownFileTree(page, folderPath, book, childNode);
        }
    }
}


// browserpage, bookName, url
async function downloadMardown(page, rootPath, book, mdname, docUrl) {
    const url = 'https://www.yuque.com/' + docUrl + '/markdown?attachment=true&latexcode=false&anchor=false&linebreak=false';
    // console.log(book + "/" + mdname + "'s download URL is: " + url)
    // console.log(rootPath)

    await downloadFile(page, rootPath, book, mdname, url)
    // await page.waitForTimeout(1000);
}

async function downloadFile(page, rootPath, book, mdname, url, maxRetries = 3) {
    var retries = 0;

    async function downloadWithRetries() {
        try {
            await goto(page, url);
            console.log(`Waiting download document to ${rootPath}\\${mdname}`);
            await waitForDownload(rootPath, book, mdname);
            console.log();
        } catch (error) {
            console.log(error);
            if (retries < maxRetries) {
                console.log(`Retrying download... (attempt ${retries + 1})`);
                retries++;
                await downloadWithRetries();
            } else {
                console.log(`Download error after ${maxRetries} retries: ${error}`);
                writeStats.filesErrored++;
            }
        }
    }

    await downloadWithRetries();
}

async function goto(page, link) {
    page.evaluate((link) => {
        location.href = link;
    }, link);
}

function computeHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

async function writeFileWithStrategy(filePath, content, book, mdname) {
    try {
        if (WRITE_STRATEGY === 'skip-unchanged') {
            if (fs.existsSync(filePath)) {
                const existingContent = fs.readFileSync(filePath);
                const existingHash = computeHash(existingContent);
                const newHash = computeHash(content);
                
                if (existingHash === newHash) {
                    console.log(`Skipped (unchanged): ${book}/${mdname}`);
                    writeStats.filesSkippedUnchanged++;
                    return;
                }
            }
        }
        
        // Write atomically: write to .tmp then rename
        const tmpPath = `${filePath}.tmp`;
        fs.writeFileSync(tmpPath, content);
        fs.renameSync(tmpPath, filePath);
        console.log(`Written: ${book}/${mdname}`);
        writeStats.filesWritten++;
    } catch (error) {
        console.error(`Error writing ${book}/${mdname}: ${error.message}`);
        writeStats.filesErrored++;
        throw error;
    }
}
  
async function waitForDownload(rootPath, book, mdname, started = false) {
    const timeout = 10000; // 10s timeout
    return new Promise((resolve, reject) => {
        // console.log(`======> watch ${rootPath} ${mdname}.md`)
        const watcher = fs.watch(rootPath, (eventType, filename) => {
            // console.log(`watch ${rootPath} ${eventType} ${filename}, want ${mdname}.md`)
            if (eventType === 'rename' && filename === `${mdname}.md.crdownload` && !started) {
                console.log("Downloading document " + book + "/" + mdname)
                started = true
            }

            if (eventType === 'rename' && filename === `${mdname}.md` && started) {
                watcher.close();
                
                // Apply write strategy after download completes
                const filePath = path.join(rootPath, `${mdname}.md`);
                const tempPath = path.join(rootPath, `${mdname}.md.download`);
                
                try {
                    // Rename downloaded file to temp location
                    fs.renameSync(filePath, tempPath);
                    
                    // Read the downloaded content
                    const content = fs.readFileSync(tempPath);
                    
                    // Apply write strategy
                    writeFileWithStrategy(filePath, content, book, mdname).then(() => {
                        // Clean up temp file
                        if (fs.existsSync(tempPath)) {
                            fs.unlinkSync(tempPath);
                        }
                        resolve(filename);
                    }).catch((error) => {
                        // Clean up temp file on error
                        if (fs.existsSync(tempPath)) {
                            fs.unlinkSync(tempPath);
                        }
                        reject(error);
                    });
                } catch (error) {
                    console.error(`Error applying write strategy: ${error.message}`);
                    writeStats.filesErrored++;
                    // If we can't apply strategy, just keep the original file
                    if (fs.existsSync(tempPath)) {
                        fs.renameSync(tempPath, filePath);
                    }
                    resolve(filename);
                }
            }
        });

        setTimeout(() => {
            watcher.close();
            reject(new Error('Download timed out'));
        }, timeout);
    });
}
