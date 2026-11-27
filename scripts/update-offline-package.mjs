// Run after changing a packaged file: node scripts/update-offline-package.mjs
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const listName='adk-assets/resource-list.js',packageName='adk-package-data.js';
const source=await readFile(path.join(root,listName),'utf8');
const resources=JSON.parse(source.replace(/^\s*window\.ADKOfflineResources\s*=\s*/,'').replace(/;\s*$/,''));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const contents=new Map();
for(const file of resources.files) {
  const relative=path.relative(root,path.resolve(root,file.name));
  if(relative.startsWith('..')||path.isAbsolute(relative))throw Error(`Invalid resource path: ${file.name}`);
  if(file.name===listName||file.name===packageName){delete file.sha256;continue;}
  const bytes=await readFile(path.join(root,file.name));
  contents.set(file.name,bytes);
  file.sha256=hash(bytes);
}
resources.revision=hash(JSON.stringify(resources.files.filter(file=>file.sha256).map(({name,sha256})=>({name,sha256}))));
const list=Buffer.from('window.ADKOfflineResources='+JSON.stringify(resources)+';\r\n');
contents.set(listName,list);
const archive={files:resources.files.filter(file=>file.name!==packageName).map(file=>({name:file.name,base64:contents.get(file.name).toString('base64')}))};
const encoded=gzipSync(Buffer.from(JSON.stringify(archive)),{level:9}).toString('base64');
// Prepare both artifacts before writing so read/compression failures leave the previous package intact.
await writeFile(path.join(root,listName),list);
await writeFile(path.join(root,packageName),'window.ADKOfflinePackageData='+JSON.stringify(encoded)+';\r\n');
console.log(`Updated ${archive.files.length} packaged files; revision ${resources.revision}`);
