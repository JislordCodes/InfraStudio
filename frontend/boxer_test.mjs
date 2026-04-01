import * as THREE from 'three';
import * as OBC from '@thatopen/components';

const components = new OBC.Components();
const boxer = components.get(OBC.BoundingBoxer);
console.log('BoundingBoxer methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(boxer)));
