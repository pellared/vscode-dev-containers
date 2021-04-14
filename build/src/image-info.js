const path = require('path');
const push = require('./push').push;
const asyncUtils = require('./utils/async');
const configUtils = require('./utils/config');
const imageContentUtils = require('./utils/image-content-extractor');
const componentFormatterFactory = require('./utils/component-formatter-factory');
const markdownFormatterFactory = require('./utils/markdown-formatter-factory');

async function generateImageInformationFiles(repo, release, registry, registryPath, 
    stubRegistry, stubRegistryPath, buildFirst, pruneBetweenDefinitions, generateCgManifest, generateMarkdown, definitionId) {
    // Load config files
    await configUtils.loadConfig();

    const alreadyRegistered = {};
    const cgManifest = {
        "Registrations": [],
        "Version": 1
    }

    console.log('(*) Generating image information files...');
    const definitions = definitionId ? [definitionId] : configUtils.getSortedDefinitionBuildList();
    await asyncUtils.forEach(definitions, async (currentDefinitionId) => {
        const definitionInfo = await getDefinitionImageContent(repo, release, registry, registryPath,  stubRegistry, stubRegistryPath, currentDefinitionId, alreadyRegistered, buildFirst);

        if (generateMarkdown) {
            // Write version history file
            console.log('(*) Writing image history markdown...');
            const definitionRelativePath = configUtils.getDefinitionPath(currentDefinitionId, true);
            const historyFolder = path.join(__dirname, '..', '..', definitionRelativePath, 'history');
            await asyncUtils.mkdirp(historyFolder);
            await asyncUtils.writeFile(path.join(historyFolder, `${definitionInfo.version}.md`), definitionInfo.markdown);
        }

        // Add component registrations if we're using them
        if (generateCgManifest) {
            cgManifest.Registrations = cgManifest.Registrations.concat(definitionInfo.registrations);     
        }
        // Prune images if setting enabled
        if (pruneBetweenDefinitions) {
            await asyncUtils.spawn('docker', ['image', 'prune', '-a', '-f']);
        }
    });

    // Write final cgmanifest.json file if needed
    if(generateCgManifest) {
        console.log('(*) Writing cgmanifest.json...');
        await asyncUtils.writeFile(
            path.join(__dirname, '..', '..', 'cgmanifest.json'),
            JSON.stringify(cgManifest, undefined, 4));
    }
    console.log('(*) Done!');    
}

async function getDefinitionImageContent(repo, release, registry, registryPath, stubRegistry, stubRegistryPath, definitionId, alreadyRegistered, buildFirst) {
    const dependencies = configUtils.getDefinitionDependencies(definitionId);
    if (typeof dependencies !== 'object') {
        return [];
    }

    let registrations = [];

    // Create header for markdown
    let markdown = await generateReleaseNotesHeader(release, definitionId);

    const variants = configUtils.getVariants(definitionId) || [null];
    const version = configUtils.getVersionFromRelease(release, definitionId);
    await asyncUtils.forEach(variants, async (variant) => {
        if(variant) {
            console.log(`\n(*) Processing variant ${variant}...`);
        }

        const imageTag = configUtils.getTagsForVersion(definitionId, version, registry, registryPath, variant)[0];
        if (buildFirst) {
            // Build but don't push images
            console.log('(*) Building image...');
            await push(repo, release, false, registry, registryPath, registry, registryPath, false, false, [], 1, 1, false, definitionId);
        } else {
            console.log(`(*) Pulling image ${imageTag}...`);
            await asyncUtils.spawn('docker', ['pull', imageTag]);
        }

        // Extract content information
        const contents = await imageContentUtils.getAllContentInfo(imageTag, dependencies);
        
        // Update markdown content
        markdown = markdown + await generateReleaseNotesPart(contents, release, stubRegistry, stubRegistryPath, definitionId, variant);

        // Add to registrations
        registrations = registrations.concat(getUniqueComponents(alreadyRegistered, contents));
    });

    // Register upstream images
    await asyncUtils.forEach(dependencies.imageVariants, (async (imageTag) => {
        if (typeof alreadyRegistered[imageTag] === 'undefined') {
            const [image, imageVersion] = imageTag.split(':');
            registrations.push({
                "Component": {
                    "Type": "other",
                    "Other": {
                        "Name": `Docker Image: ${image}`,
                        "Version": imageVersion,
                        "DownloadUrl": dependencies.imageLink
                    }
                }
            });
            alreadyRegistered[dependencies.image] = [imageVersion];
        }
    }));

    return {
        registrations: registrations,
        markdown: markdown,
        version: version
    }
}

// Filter out components already in the registration list and format output returns an array of formatted and filtered contents
function getUniqueComponents(alreadyRegistered, contents) {
    let componentList = [];

    const contentFormatter = componentFormatterFactory.getFormatter(contents.distro);
    for (let contentType in contents) {
        const formatterFn = contentFormatter[contentType];
        let content = contents[contentType];
        if (formatterFn && content) {
            if(!Array.isArray(content)) {
                content = [content];
            }
            componentList = componentList.concat(content.reduce((prev, next) => {
                const uniqueId = JSON.stringify(next);
                if(!alreadyRegistered[uniqueId]) {
                    alreadyRegistered[uniqueId] = true;
                    const component = formatterFn(next);
                    if(component) {
                        prev.push(component);
                    }
                }
                return prev;
            }, []));
        }
    }
    
    return componentList;
}

// Use template to generate header of version markdown content
async function generateReleaseNotesHeader(release, definitionId) {
    const version = configUtils.getVersionFromRelease(release, definitionId);
    let markdown = await asyncUtils.readFile(path.join(__dirname, '..', 'assets', 'release-notes-header.md'));
    markdown = markdown.replace(/\${definition}/gm, definitionId);
    markdown = markdown.replace(/\${release}/gm, release);
    markdown = markdown.replace(/\${version}/gm, version);
    return markdown;
}

// Generate 
async function generateReleaseNotesPart(contents, release, stubRegistry, stubRegistryPath, definitionId, variant) {
    const markdownFormatter = markdownFormatterFactory.getFormatter();
    const formattedContents = getFormattedContents(contents, markdownFormatter);
    let markdown = await asyncUtils.readFile(path.join(__dirname, '..', 'assets', 'release-notes-variant-part.md'));

    const tags = configUtils.getTagList(definitionId, release, 'full-only', stubRegistry,  stubRegistryPath, variant);
    if(variant) {
        markdown = markdown.replace(`\${variant}`, variant);
    } else {
        markdown = markdown.replace(/<!--\s*variant start\s*-->(.*\n)*<!--\svariant end\s-->\n?/m,'');
    }

    markdown = markdown.replace(`\${tags}`, tags.reduce((prev, next) => prev + next + '\n', '').trim());
    for (let contentType in contents) {
        let content = formattedContents[contentType] || '';
        if(Array.isArray(content)) {
            content = content.reduce((prev, next) => `${prev}${next}\n`, '');
        }
        if(content.length > 0) {
            markdown = markdown.replace(`\${${contentType}}`, content.trim());
        } else {
            const contentTagRemoveRegex = new RegExp(`\\$\\{${contentType}\\}\\n?`)
            markdown = markdown.replace(contentTagRemoveRegex,'');
            // Treat pip and pipx as the same section - don't remove if one or the other are present
            if(contentType === 'pip' || contentType === 'pipx' ) {
                if ((!contents.pip || contents.pip.length === 0) && 
                    (!contents.pipx || contents.pipx.length === 0)) {
                    contentType = 'pip';
                } else {
                    contentType = null;
                }
            }
            const sectionRemoveRegex = new RegExp(`<!--\\s${contentType} start\\s*-->(.*\\n)*<!--\\s*${contentType} end\\s*-->\\n?`,'gm');
            markdown = markdown.replace(sectionRemoveRegex, '');
        }
    }
    return markdown;
}

// Return all contents as an object of formatted values
function getFormattedContents(contents, contentFormatter) {
    let formattedContents = {};
    for (let contentType in contents) {
        formattedContents[contentType] = getFormattedContent(contents[contentType], contentFormatter[contentType]);
    }    
    return formattedContents;
}

function getFormattedContent(content, formatterFn) {
    if (!formatterFn || !content) {
        return null;
    }
    if(!Array.isArray(content)) {
        return formatterFn(content);
    }
    return content.reduce((prev, next) => {
        const formattedContent = formatterFn(next);
        if(formattedContent) {
            prev.push(formattedContent);
        }
        return prev;
    }, []);    
}

module.exports = {
    generateImageInformationFiles: generateImageInformationFiles
}
