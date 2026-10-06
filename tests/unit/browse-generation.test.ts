// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useBrowsePagination } from '../../src/renderer/use-browse-pagination';

function deferred() {
 let resolve!: (value: unknown) => void;
 const promise = new Promise<unknown>(r => { resolve = r; });
 return {promise,resolve};
}
const asset=(id: string)=>({assetId:id,displayName:id+'.png',relativeFilePath:id+'.png',width:120,height:80,mediaType:'image',thumbnailArtifactId:null}) as never;
const page=(id:string,offset=100)=>({ok:true,value:{items:[asset(id)],total:7000,offset}});

it('isolates an old stale page from the new session and its in-flight marker',async()=>{
 const old=deferred(),current=deferred();
 const fetchBrowseSessionPage=vi.fn((input:{sessionId:string})=> input.sessionId==='old' ? old.promise : current.promise);
 const searchAssets=vi.fn(async()=>page('live'));
 const api={fetchBrowseSessionPage,searchAssets} as never;
 let controller!: ReturnType<typeof useBrowsePagination>;
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 const noop=vi.fn();
 function Shell(){controller=useBrowsePagination({api,setAssets:noop,setTrashedAssets:noop,setBrowseLayout:noop,setVirtualBrowseLayout:noop,setSearchTotal:noop,setSearchOffset:noop,setSearchSnippets:noop});return null;}
 const begin=(sessionId:string)=>controller.beginPage({kind:'search',libraryId:'lib',sessionId,query:null,scope:null,sort:null,showIgnored:false,target:'assets'},{items:[asset(sessionId)],total:7000,offset:0});
 try{
 await act(async()=>root.render(createElement(Shell)));
 await act(async()=>begin('old'));
 let oldRequest!:Promise<void>;
 await act(async()=>{oldRequest=controller.ensureVisibleRange(100,120)});
 await act(async()=>begin('new'));
 let currentRequest!:Promise<void>;
 await act(async()=>{currentRequest=controller.ensureVisibleRange(100,120)});
 expect(fetchBrowseSessionPage).toHaveBeenCalledTimes(2);
 await act(async()=>{old.resolve({ok:true,value:{stale:true}});await oldRequest});
 await act(async()=>{await controller.ensureVisibleRange(100,120)});
 // Neither a fallback for the old scope nor a duplicate of the pending new page is allowed.
 expect(searchAssets).not.toHaveBeenCalled();
 expect(fetchBrowseSessionPage).toHaveBeenCalledTimes(2);
 await act(async()=>{current.resolve(page('new'));await currentRequest});
 }finally{await act(async()=>root.unmount());container.remove();}
});

