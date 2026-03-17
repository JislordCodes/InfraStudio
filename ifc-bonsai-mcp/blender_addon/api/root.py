"""Generic IFC Element Management API Functions for IFC Bonsai MCP

This module provides core IFC element operations including copying, reassigning classes,
and deletion of IFC objects with proper relationship handling.

Test Examples:
    copy_class(product_guid="1AbCdEfGhIjKlMnOp", copy_representations=False, copy_property_sets=True)
    reassign_class(product_guid="1AbCdEfGhIjKlMnOp", new_ifc_class="IfcWall", predefined_type="STANDARD")
    delete_ifc_objects(guids=["1AbCdEfGhIjKlMnOp"], use_selection=False, remove_fillings=True)
    delete_ifc_objects(use_selection=True, remove_fillings=True)

Features:
- Copy IFC products with relationships (placement, properties, materials, etc.)
- Reassign IFC classes while preserving relationships and geometry
- Delete IFC objects by GUID or current selection with special opening handling
"""

from typing import List, Optional, Dict, Any, Union
import ifcopenshell
import ifcopenshell.api
from dataclasses import dataclass

from .ifc_utils import get_ifc_file, save_and_load_ifc, get_selected_guids
from . import register_command


@dataclass
class ElementDeletionResult:
    """Result data for IFC element deletion operations."""
    success: bool
    deleted_count: int
    deleted_guids: List[str]
    removed_fillings: List[str]
    errors: List[str]
    message: str


def _get_element_by_guid(ifc_file, guid: str) -> Optional[ifcopenshell.entity_instance]:
    """Retrieve an IFC element by its GlobalId.
    
    Args:
        ifc_file: The IFC file instance
        guid: The GlobalId string to search for
        
    Returns:
        IFC element if found, None otherwise
    """
    try:
        return ifc_file.by_guid(guid)
    except Exception:
        return None


def _collect_elements(ifc_file, guids: Optional[List[str]], use_selection: bool) -> List[ifcopenshell.entity_instance]:
    """Collect IFC elements from GUIDs and/or current Blender selection.
    
    Args:
        ifc_file: The IFC file instance
        guids: Optional list of GlobalIds to collect
        use_selection: Whether to include elements from current Blender selection
        
    Returns:
        List of unique IFC elements found
    """
    elements = []
    seen = set()

    if use_selection:
        selected_guids = get_selected_guids()
        
        for guid in selected_guids:
            if guid not in seen:
                el = _get_element_by_guid(ifc_file, guid)
                if el:
                    elements.append(el)
                    seen.add(guid)

    if guids:
        for guid in guids:
            if guid in seen:
                continue
            el = _get_element_by_guid(ifc_file, guid)
            if el:
                elements.append(el)
                seen.add(guid)

    return elements


@register_command('copy_class', description="Copy an IFC product with relationships")
def copy_class(
    product_guid: str,
    copy_representations: bool = False,
    copy_property_sets: bool = True,
    copy_material: bool = True,
    copy_placement: bool = True,
    verbose: bool = False
) -> Dict[str, Any]:
    """Copy an IFC product with all its relationships and properties.
    
    Creates a duplicate of an existing IFC product while preserving:
    - Object placement coordinates (same location as original)
    - Property sets, properties, and quantities
    - Nested distribution ports
    - Aggregate relationships
    - Spatial containment
    - Type associations (for occurrences)
    - Voids (duplicated)
    - Material assignments (including parametric material sets)
    - Group memberships
    
    Note: Representations are optionally copied (expensive operation).
    Filled voids and path connectivity are not copied.
    
    Args:
        product_guid: GlobalId of the IFC product to copy
        copy_representations: Whether to copy geometric representations (default False for performance)
        copy_property_sets: Whether to copy property sets and quantities (default True)
        copy_material: Whether to copy material assignments (default True)
        copy_placement: Whether to copy the placement (if False, new placement at origin) (default True)
        verbose: Enable detailed logging (default False)
        
    Returns:
        Dict containing:
            - success: Boolean indicating operation success
            - original_guid: GUID of the original product
            - new_guid: GUID of the copied product
            - class: IFC class of the copied element
            - message: Descriptive message
            - error: Error message if success is False
    """
    ifc_file = get_ifc_file()
    
    try:
        original = _get_element_by_guid(ifc_file, product_guid)
        if not original:
            return {
                "success": False,
                "error": f"Product with GUID {product_guid} not found",
                "original_guid": product_guid,
                "new_guid": None,
                "class": None,
                "message": f"Failed to find product with GUID {product_guid}"
            }
        
        if not hasattr(original, 'GlobalId'):
            return {
                "success": False,
                "error": f"Entity is not a rooted element with GlobalId",
                "original_guid": product_guid,
                "new_guid": None,
                "class": original.is_a() if original else None,
                "message": "Entity must be a rooted IFC element with GlobalId"
            }
        
        copied = ifcopenshell.api.run("root.copy_class", ifc_file, product=original)
        
        if not copy_representations:
            if hasattr(copied, 'Representation') and copied.Representation:
                copied.Representation = None
                if verbose:
                    print(f"Removed representation from copied element {copied.GlobalId}")
        
        if not copy_placement:
            if hasattr(copied, 'ObjectPlacement') and copied.ObjectPlacement:
                copied.ObjectPlacement = None
                if verbose:
                    print(f"Removed placement from copied element {copied.GlobalId}")
        
        save_and_load_ifc()
        
        if verbose:
            print(f"Successfully copied {original.is_a()} {original.GlobalId} to {copied.GlobalId}")
        
        return {
            "success": True,
            "original_guid": product_guid,
            "new_guid": copied.GlobalId if hasattr(copied, 'GlobalId') else None,
            "class": copied.is_a() if copied else None,
            "message": f"Successfully copied {original.is_a()} '{getattr(original, 'Name', 'Unnamed')}' to new instance"
        }
        
    except Exception as e:
        error_msg = f"Failed to copy product {product_guid}: {str(e)}"
        if verbose:
            print(error_msg)
        return {
            "success": False,
            "error": error_msg,
            "original_guid": product_guid,
            "new_guid": None,
            "class": None,
            "message": "Copy operation failed due to an error"
        }


@register_command('reassign_class', description="Change the IFC class of a product")
def reassign_class(
    product_guid: str,
    new_ifc_class: str,
    predefined_type: Optional[str] = None,
    occurrence_class: Optional[str] = None,
    verbose: bool = False
) -> Dict[str, Any]:
    """Change the IFC class of a product while retaining all relationships.
    
    This function is useful for fixing incorrectly classified elements imported
    from other software. It retains all geometry and relationships during the
    reclassification process.
    
    For type objects: All occurrences are also reassigned to maintain IFC validity.
    For occurrence objects: In IFC4+ the associated type is also reassigned.
    
    Args:
        product_guid: GlobalId of the product to reassign
        new_ifc_class: New IFC class name (e.g., 'IfcWall', 'IfcSlab', 'IfcWallType')
        predefined_type: Optional predefined type for the new class
        occurrence_class: For type reassignment in IFC2X3, specify occurrence class
        verbose: Enable detailed logging (default False)
        
    Returns:
        Dict containing:
            - success: Boolean indicating operation success
            - guid: GUID of the reassigned product
            - old_class: Original IFC class name
            - new_class: New IFC class name
            - predefined_type: Applied predefined type if any
            - message: Descriptive message
            - error: Error message if success is False
    """
    ifc_file = get_ifc_file()
    
    try:
        product = _get_element_by_guid(ifc_file, product_guid)
        if not product:
            return {
                "success": False,
                "error": f"Product with GUID {product_guid} not found",
                "guid": product_guid,
                "old_class": None,
                "new_class": new_ifc_class,
                "predefined_type": predefined_type,
                "message": f"Failed to find product with GUID {product_guid}"
            }
        
        old_class = product.is_a()
        old_name = getattr(product, 'Name', 'Unnamed')
        
        if verbose:
            print(f"Reassigning {old_class} '{old_name}' to {new_ifc_class}")
        
        reassigned = ifcopenshell.api.run(
            "root.reassign_class",
            ifc_file,
            product=product,
            ifc_class=new_ifc_class,
            predefined_type=predefined_type,
            occurrence_class=occurrence_class
        )
        
        save_and_load_ifc()
        
        new_predefined_type = getattr(reassigned, 'PredefinedType', None) if reassigned else None
        final_class = reassigned.is_a() if reassigned else new_ifc_class
        
        if verbose:
            print(f"Successfully reassigned to {final_class} with predefined type: {new_predefined_type}")
        
        return {
            "success": True,
            "guid": reassigned.GlobalId if hasattr(reassigned, 'GlobalId') else product_guid,
            "old_class": old_class,
            "new_class": final_class,
            "predefined_type": new_predefined_type,
            "message": f"Successfully reassigned '{old_name}' from {old_class} to {final_class}"
        }
        
    except Exception as e:
        error_msg = f"Failed to reassign product {product_guid}: {str(e)}"
        if verbose:
            print(error_msg)
        return {
            "success": False,
            "error": error_msg,
            "guid": product_guid,
            "old_class": None,
            "new_class": new_ifc_class,
            "predefined_type": predefined_type,
            "message": "Reassignment operation failed due to an error"
        }


@register_command('delete_ifc_objects', description="Delete IFC objects by GUID or current selection")
def delete_ifc_objects(
    guids: Optional[List[str]] = None,
    use_selection: bool = False,
    remove_fillings: bool = True,
    verbose: bool = False
) -> Dict[str, Any]:
    """Delete IFC objects by GUID or current Blender selection.
    
    This function provides flexible deletion of IFC elements with special handling
    for opening elements and their fillings. It can target specific elements by
    GUID or operate on the current Blender selection.

    Args:
        guids: List of IFC GlobalIds to delete. Ignored if empty and use_selection=True
        use_selection: When True, delete IFC entities associated with selected Blender objects
        remove_fillings: For IfcOpeningElement, also remove any filling elements (default True)
        verbose: Enable detailed logging (default False)

    Returns:
        Dict containing:
            - success: Boolean indicating if any deletions occurred
            - deleted_count: Number of elements successfully deleted
            - deleted_guids: List of GUIDs of deleted elements
            - removed_fillings: List of GUIDs of removed filling elements
            - errors: List of error messages encountered
            - message: Summary message
    """
    ifc_file = get_ifc_file()

    errors: List[str] = []
    deleted_guids: List[str] = []
    removed_fillings: List[str] = []

    try:
        targets = _collect_elements(ifc_file, guids, use_selection)

        if not targets:
            return {
                "success": False,
                "deleted_count": 0,
                "deleted_guids": [],
                "removed_fillings": [],
                "errors": ["No target IFC elements found (check GUIDs or selection)"],
                "message": "No elements found for deletion"
            }

        if verbose:
            print(f"Found {len(targets)} elements to delete")

        for el in targets:
            try:
                element_guid = getattr(el, 'GlobalId', None)
                cls = el.is_a()
                element_name = getattr(el, 'Name', 'Unnamed')
                
                if verbose:
                    print(f"Processing {cls} '{element_name}' ({element_guid})")
                
                # Special handling for opening elements
                if cls == 'IfcOpeningElement':
                    if remove_fillings:
                        try:
                            fillings_to_remove = []
                            for rel in getattr(el, 'HasFillings', []) or []:
                                filling = getattr(rel, 'RelatedBuildingElement', None)
                                if filling is not None:
                                    fillings_to_remove.append(filling)
                            
                            for filling in fillings_to_remove:
                                ifcopenshell.api.run("root.remove_product", ifc_file, product=filling)
                                filling_guid = getattr(filling, 'GlobalId', None)
                                if filling_guid:
                                    removed_fillings.append(filling_guid)
                                    if verbose:
                                        print(f"  Removed filling {filling.is_a()} ({filling_guid})")
                                        
                        except Exception as e:
                            error_msg = f"Failed removing fillings for opening {element_guid}: {str(e)}"
                            errors.append(error_msg)
                            if verbose:
                                print(f"  {error_msg}")
                    
                    ifcopenshell.api.run("feature.remove_feature", ifc_file, feature=el)
                    if element_guid:
                        deleted_guids.append(element_guid)
                        if verbose:
                            print(f"  Removed opening {element_guid}")
                else:
                    ifcopenshell.api.run("root.remove_product", ifc_file, product=el)
                    if element_guid:
                        deleted_guids.append(element_guid)
                        if verbose:
                            print(f"  Removed product {element_guid}")
                            
            except Exception as e:
                element_guid = getattr(el, 'GlobalId', 'Unknown')
                element_class = getattr(el, 'is_a', lambda: 'Unknown')()
                error_msg = f"Error deleting {element_guid} ({element_class}): {str(e)}"
                errors.append(error_msg)
                if verbose:
                    print(f"  {error_msg}")

        save_and_load_ifc()
        
        total_deleted = len(deleted_guids)
        total_fillings_removed = len(removed_fillings)
        success = total_deleted > 0
        
        if verbose:
            print(f"Deletion complete: {total_deleted} elements, {total_fillings_removed} fillings, {len(errors)} errors")

        return {
            "success": success,
            "deleted_count": total_deleted,
            "deleted_guids": deleted_guids,
            "removed_fillings": removed_fillings,
            "errors": errors,
            "message": f"Successfully deleted {total_deleted} IFC object(s)" + 
                      (f" and {total_fillings_removed} filling(s)" if total_fillings_removed > 0 else "") +
                      (f" with {len(errors)} error(s)" if errors else "")
        }

    except Exception as e:
        error_msg = f"Critical error during deletion operation: {str(e)}"
        errors.append(error_msg)
        if verbose:
            print(error_msg)
        return {
            "success": False,
            "deleted_count": 0,
            "deleted_guids": [],
            "removed_fillings": [],
            "errors": errors,
            "message": "Deletion operation failed due to critical error"
        }
