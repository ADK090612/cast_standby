(() => {
    'use strict';
    const scriptURL = document.currentScript.src;
    const base = new URL('./', scriptURL);
    const encoder = new TextEncoder();
    let loading;
    function packageData() {
        if (window.ADKOfflinePackageData) return Promise.resolve(window.ADKOfflinePackageData);
        if (!loading) loading = new Promise((resolve,reject) => {
            const script=document.createElement('script');
            script.src=new URL('adk-package-data.js',base).href;
            script.onload=()=>window.ADKOfflinePackageData ? resolve(window.ADKOfflinePackageData) : reject(new Error('패키지 데이터가 올바르지 않습니다.'));
            script.onerror=()=>reject(new Error('패키지 데이터를 읽지 못했습니다. adk-package-data.js 파일이 같은 폴더에 있는지 확인하세요.'));
            document.head.append(script);
        }).catch(error=>{loading=null;throw error});
        return loading;
    }
    async function zip(files) {
        const parts = [], central = [];
        let offset = 0, centralSize = 0;
        const table = Uint32Array.from({length:256}, (_,n) => { let c=n; for(let k=0;k<8;k++) c=(c&1)?0xedb88320^(c>>>1):c>>>1; return c>>>0; });
        const checksum = bytes => { let c=0xffffffff; for(const value of bytes) c=table[(c^value)&255]^(c>>>8); return (c^0xffffffff)>>>0; };
        for (const file of files) {
            const name = encoder.encode('ADK-Offline/' + file.name);
            const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
            const crc = checksum(data);
            let payload=data,method=0;
            if(/\.(?:html|js|css|json|txt)$/.test(file.name)&&'CompressionStream' in window){
                // ZIP uses raw DEFLATE; the deflate stream's two-byte zlib header and Adler trailer are omitted.
                const stream=new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
                const wrapped=new Uint8Array(await new Response(stream).arrayBuffer());
                const compressed=wrapped.subarray(2,wrapped.length-4);
                if(compressed.length<data.length){payload=compressed;method=8}
            }
            const header = new Uint8Array(30 + name.length), h = new DataView(header.buffer);
            h.setUint32(0,0x04034b50,true); h.setUint16(4,20,true); h.setUint16(6,0x800,true);h.setUint16(8,method,true);
            h.setUint16(12,0x21,true); h.setUint32(14,crc,true); h.setUint32(18,payload.length,true); h.setUint32(22,data.length,true); h.setUint16(26,name.length,true); header.set(name,30);
            const record = new Uint8Array(46+name.length), r = new DataView(record.buffer);
            r.setUint32(0,0x02014b50,true); r.setUint16(4,20,true); r.setUint16(6,20,true); r.setUint16(8,0x800,true);r.setUint16(10,method,true);r.setUint16(14,0x21,true);
            r.setUint32(16,crc,true); r.setUint32(20,payload.length,true); r.setUint32(24,data.length,true); r.setUint16(28,name.length,true); r.setUint32(42,offset,true); record.set(name,46);
            parts.push(header,payload); central.push(record); offset+=header.length+payload.length; centralSize+=record.length;
        }
        const end = new Uint8Array(22), e = new DataView(end.buffer);
        e.setUint32(0,0x06054b50,true); e.setUint16(8,files.length,true); e.setUint16(10,files.length,true); e.setUint32(12,centralSize,true); e.setUint32(16,offset,true);
        return new Blob([...parts,...central,end], {type:'application/zip'});
    }
    window.ADKOfflineDownload = async function(setStatus) {
        setStatus('별도 패키지 데이터를 읽고 있습니다…');
        const encoded=await packageData();
        const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
        const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        const archive=JSON.parse(await new Response(stream).text());
        setStatus('오프라인 ZIP 패키지를 만들고 있습니다…');
        const files=archive.files.map(file=>({name:file.name,data:Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0))}));
        // Recreate the lazy data file from its value so packages can be downloaded again offline.
        files.push({name:'adk-package-data.js',data:'window.ADKOfflinePackageData='+JSON.stringify(encoded)+';\n'});
        const blob=await zip(files), url=URL.createObjectURL(blob), link=document.createElement('a');
        link.href=url; link.download='ADK-Offline.zip'; document.body.append(link); link.click(); link.remove();
        setTimeout(()=>URL.revokeObjectURL(url),60000);
        setStatus('ZIP 패키지 저장을 요청했습니다. 압축을 해제한 ADK-Offline 폴더 전체를 함께 보관하세요.');
    };
})();
